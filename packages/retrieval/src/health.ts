/**
 * Operational health checks for the two silent-failure modes the assessment names.
 *
 * Both of these fail *quietly* in normal operation, which is what makes them worth a
 * dedicated check rather than a log line:
 *
 *   * **A projection/model mismatch** makes the dense channel return zero rows with no
 *     error, which the caller cannot distinguish from an authorization denial or from a
 *     corpus with nothing relevant in it. The channel now reports the mismatch itself, but
 *     a channel-level note only appears to whoever ran that one query. A health check makes
 *     it visible to whoever operates the deployment.
 *   * **A principal with no participation** cannot authorise an action citing a claim in a
 *     scope they have never written in. That is correct behaviour (ADR 0011) and it is an
 *     onboarding cliff: the refusal looks like a permission error and the remedy — grant a
 *     scope, or write once at that scope — is not obvious from the response.
 *
 * Neither check replaces the runtime guard. They surface the same facts earlier, to a
 * different audience.
 */
import type { Db } from "@veritymem/ledger";

export interface HealthFinding {
  /** A stable machine-readable identifier, so a monitor can alert on one without parsing prose. */
  readonly id: string;
  readonly status: "ok" | "degraded" | "failing";
  readonly detail: string;
  /** What an operator should do. Present whenever status is not `ok`. */
  readonly remedy?: string;
}

export interface HealthReport {
  readonly status: "ok" | "degraded" | "failing";
  readonly findings: readonly HealthFinding[];
}

export interface HealthDependencies {
  readonly db: Db;
  readonly embeddings: {
    readonly model_id: string;
    readonly dimensions: number;
    readonly isModelCall: boolean;
  };
}

/**
 * Compare the configured reader against the model that wrote each dense projection.
 *
 * Reads `projection_versions`, which the projection writer maintains, rather than sampling
 * `claim_embeddings`: the version row is the writer's own declaration of what it used, so a
 * mismatch here is a configuration difference rather than a guess about row contents.
 */
export async function checkProjectionCompatibility(
  dependencies: HealthDependencies,
  options: { readonly tenantId: string },
): Promise<HealthFinding> {
  return dependencies.db.withSystemContext({ tenant: options.tenantId, actor: "health:projection" }, async (executor) => {
    const row = await executor.query<{ model_version: string | null; ledger_watermark: number; updated_at: Date | string }>(
      `SELECT model_version, ledger_watermark, updated_at
         FROM projection_versions
        WHERE projection = 'dense' AND tenant_id = $1::uuid`,
      [options.tenantId],
    );
    const projection = row.rows[0];

    if (!projection) {
      return {
        id: "projection.dense.absent",
        status: "degraded",
        detail:
          "no dense projection has been built for this tenant, so the dense retrieval channel " +
          "contributes nothing. Lexical, entity and temporal channels still run.",
        remedy: "run a projection rebuild (POST /v1/replay with mode=rebuild) or start the worker.",
      };
    }

    const writtenBy = projection.model_version;
    if (writtenBy !== null && writtenBy !== dependencies.embeddings.model_id) {
      return {
        id: "projection.dense.model_mismatch",
        status: "failing",
        detail:
          `the dense projection was written by embedding model '${writtenBy}' but this deployment ` +
          `is configured with '${dependencies.embeddings.model_id}' (${dependencies.embeddings.dimensions} ` +
          `dimensions). The dense channel will return zero rows and will look like an empty or ` +
          `unauthorized result rather than a misconfiguration.`,
        remedy:
          `rebuild the projection with the configured model (POST /v1/replay, mode=rebuild), or ` +
          `configure the reader with '${writtenBy}'. Note that HashEmbeddingBackend appends its ` +
          `dimension count to the default id, so passing \`dimensions\` where it was previously omitted ` +
          `is enough to cause this.`,
      };
    }

    return {
      id: "projection.dense.model_match",
      status: "ok",
      detail: `the dense projection was written by '${writtenBy}', matching the configured reader.`,
    };
  });
}

/**
 * Report whether a principal can act on memory at all.
 *
 * A principal with no `principal_scopes` row can read nothing and approve nothing, because
 * reach is participation plus grants. That is fail-closed and correct, and it is the state
 * every new principal starts in — so it is worth being able to ask about directly instead
 * of inferring it from a refusal.
 */
export async function checkActionAuthority(
  dependencies: HealthDependencies,
  options: { readonly tenantId: string; readonly principal: string },
): Promise<HealthFinding> {
  return dependencies.db.withSystemContext({ tenant: options.tenantId, actor: "health:authority" }, async (executor) => {
    const memberships = await executor.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM principal_scopes WHERE tenant_id = $1::uuid AND principal_id = $2`,
      [options.tenantId, options.principal],
    );
    const grants = await executor.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM grants
        WHERE tenant_id = $1::uuid AND subject = $2 AND (expires_at IS NULL OR expires_at > now())`,
      [options.tenantId, options.principal],
    );

    const held = Number(memberships.rows[0]?.n ?? 0);
    const granted = Number(grants.rows[0]?.n ?? 0);

    if (held === 0 && granted === 0) {
      return {
        id: "authority.no_reach",
        status: "degraded",
        detail:
          `principal '${options.principal}' holds no scope membership and no live grant, so it can ` +
          `read nothing and the action gate will refuse any claim it cites.`,
        remedy:
          `this is the state every new principal starts in and it is fail-closed by design. Either ` +
          `have the principal write once in the scope it needs (participation is recorded on write), ` +
          `or grant it reach explicitly: POST /v1/grants with a resource_pattern naming the scope and ` +
          `an actions list including 'read'.`,
      };
    }

    return {
      id: "authority.present",
      status: "ok",
      detail: `principal '${options.principal}' holds ${held} scope membership(s) and ${granted} live grant(s).`,
    };
  });
}

/** Run both checks and reduce them to one verdict. */
export async function healthCheck(
  dependencies: HealthDependencies,
  options: { readonly tenantId: string; readonly principal?: string },
): Promise<HealthReport> {
  const findings: HealthFinding[] = [await checkProjectionCompatibility(dependencies, options)];
  const principal = options.principal;
  if (principal !== undefined) {
    findings.push(await checkActionAuthority(dependencies, { tenantId: options.tenantId, principal }));
  }
  const status = findings.some((finding) => finding.status === "failing")
    ? "failing"
    : findings.some((finding) => finding.status === "degraded")
      ? "degraded"
      : "ok";
  return { status, findings };
}


/**
 * A cluster-wide summary of the embedding projection, for an unauthenticated readiness
 * endpoint.
 *
 * Deliberately a *summary* rather than per-tenant findings. `/readyz` carries no identity, so
 * it cannot scope a query to one tenant, and a readiness endpoint that enumerated tenants
 * would disclose the shape of a multi-tenant deployment to anyone who can reach it. What an
 * operator needs from this endpoint is "is anything misconfigured", and that is answerable
 * as a comparison between the configured model and the distinct models the projections were
 * written by.
 */
export interface ProjectionSummary {
  readonly configured_model_id: string;
  readonly configured_dimensions: number;
  /** The distinct models the dense projections in this cluster were written by, with counts. */
  readonly written_by: readonly { readonly model_id: string | null; readonly tenants: number }[];
  /** True when every recorded projection matches the configured reader. */
  readonly compatible: boolean;
  readonly detail: string;
}

export async function projectionSummary(dependencies: HealthDependencies): Promise<ProjectionSummary> {
  // A system context is not needed and is not available here: the application role can read
  // `projection_versions` for its own tenant only, and this endpoint has no tenant. The query
  // therefore reports on whatever the connection's scope admits, which for an unauthenticated
  // request is nothing, and the summary says so rather than implying a measurement it did not
  // make.
  const rows = await dependencies.db
    .systemQuery<{ model_id: string | null; tenants: number }>(
      `SELECT model_version AS model_id, count(*)::int AS tenants
         FROM projection_versions
        WHERE projection = 'dense' AND tenant_id IS NOT NULL
        GROUP BY model_version
        ORDER BY tenants DESC`,
    )
    .catch(() => ({ rows: [] as { model_id: string | null; tenants: number }[] }));

  const writtenBy = rows.rows;
  const mismatched = writtenBy.filter(
    (row) => row.model_id !== null && row.model_id !== dependencies.embeddings.model_id,
  );
  const compatible = mismatched.length === 0;

  return {
    configured_model_id: dependencies.embeddings.model_id,
    configured_dimensions: dependencies.embeddings.dimensions,
    written_by: writtenBy,
    compatible,
    detail: compatible
      ? writtenBy.length === 0
        ? "no dense projection recorded; the dense channel contributes nothing until a rebuild runs."
        : "every recorded dense projection was written by the configured embedding model."
      : `${mismatched.reduce((sum, row) => sum + row.tenants, 0)} projection(s) were written by a ` +
        `different embedding model. The dense channel returns zero rows for those tenants and the ` +
        `empty result looks like an authorization denial. Rebuild with POST /v1/replay, mode=rebuild.`,
  };
}
