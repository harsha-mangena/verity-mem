/**
 * Target-database safety for the migration rehearsal.
 *
 * ## The failure this module exists to prevent
 *
 * A rehearsal applies DDL, terminates a backend and rebuilds a projection. Run against the
 * wrong URL it would do all of that to the developer's working ledger, and the rehearsal's
 * own report would describe the result as a successful experiment. There is no undo for a
 * dropped `claim_entities` on a database nobody measured before touching.
 *
 * So the target is validated *before anything connects*, by name, against a set of rules
 * that a plausible mistake cannot satisfy:
 *
 *   1. It is a `postgres://` URL with an explicit database name.
 *   2. The name is not a PostgreSQL system database.
 *   3. The name is not the database named by the developer's own `DATABASE_URL` or
 *      `MIGRATION_DATABASE_URL`. This is the rule that matters: pointing the rehearsal at
 *      the ordinary database is the single mistake this module has to make impossible, and
 *      it is made impossible by comparing against the configured URLs rather than against
 *      a hard-coded name.
 *   4. The name contains `rehearsal`. A disposable database that does not say so in its
 *      name is one nobody can identify later; requiring the word means the target is
 *      self-describing in `pg_database`, in a connection log, and in this report.
 *   5. The name is a legal unquoted PostgreSQL identifier, because `CREATE DATABASE`
 *      cannot take a parameter and the name is therefore interpolated into DDL.
 *
 * A selected database must additionally be *empty or ours*: either it holds no tables at
 * all, or it carries the marker table this module creates. Anything else is refused rather
 * than dropped, because "there were tables we did not recognise" is exactly the situation
 * where a tool should stop and let a person look.
 */
import pg from "pg";

const { Client } = pg;

/** Every database this module creates is named with this prefix. */
export const REHEARSAL_DATABASE_PREFIX = "veritymem_rehearsal_";

/** The marker table that proves a database was created by a rehearsal. */
export const REHEARSAL_MARKER_TABLE = "vm_a2_rehearsal";

/** An exact ownership record; a table with the marker's name alone proves nothing. */
export const REHEARSAL_MARKER_SENTINEL = "veritymem.vm-a2.rehearsal.owner.v1";
export const REHEARSAL_MARKER_VERSION = "vm-a2-marker.1";

/** Databases that exist in every cluster and must never be a rehearsal target. */
export const SYSTEM_DATABASES: readonly string[] = ["postgres", "template0", "template1"];

export interface TargetValidation {
  readonly database: string;
  readonly url: string;
  /** Human-readable statements of why this target is acceptable, recorded in the report. */
  readonly protections: readonly string[];
}

/** The server identity used for every inspection and destructive action. */
export interface ClusterIdentity {
  readonly protocol: "postgres:" | "postgresql:";
  readonly host: string;
  readonly port: string;
}

export function clusterIdentityFromUrl(url: string): ClusterIdentity {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`the PostgreSQL URL could not be parsed: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`the rehearsal URL must be a postgres:// URL; got ${parsed.protocol}//`);
  }
  return {
    // postgres and postgresql are aliases for the same wire protocol. Host and port are
    // what prevent inspecting one server and mutating another.
    protocol: "postgres:",
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
  };
}

/** Refuse an explicit target on a server other than the server being administered. */
export function assertSameCluster(adminUrl: string, targetUrl: string): void {
  const admin = clusterIdentityFromUrl(adminUrl);
  const target = clusterIdentityFromUrl(targetUrl);
  if (admin.host !== target.host || admin.port !== target.port) {
    throw new Error(
      `refusing rehearsal target on ${target.host}:${target.port}: it differs from the configured ` +
        `administrative server ${admin.host}:${admin.port}. Inspection, creation and deletion must ` +
        `happen on the same PostgreSQL server as the migration target.`,
    );
  }
}

/** The database name in a connection URL, or a refusal explaining why there is none. */
export function databaseNameFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`the rehearsal URL could not be parsed: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      `the rehearsal URL must be a postgres:// URL; got ${parsed.protocol}//. ` +
        `This command creates databases, applies migrations and terminates backends.`,
    );
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (name.length === 0 || name.includes("/")) {
    throw new Error(
      `the rehearsal URL must name exactly one database; ${JSON.stringify(parsed.pathname)} ` +
        `does not. Use a URL like postgres://user:pw@host:5432/veritymem_rehearsal_local.`,
    );
  }
  return name;
}

/**
 * Refuse any target that could be the developer's own database, or that a person reading
 * `pg_database` later could not identify as disposable.
 *
 * Throws rather than returning a verdict: there is no caller that should proceed on a
 * failed validation, and a boolean would eventually be ignored.
 */
export function validateRehearsalTarget(input: {
  readonly url: string;
  /** Database names taken from the configured `DATABASE_URL` / `MIGRATION_DATABASE_URL`. */
  readonly protected_names: readonly string[];
}): TargetValidation {
  const database = databaseNameFromUrl(input.url);

  if (SYSTEM_DATABASES.includes(database)) {
    throw new Error(
      `refusing to rehearse against ${database}: it is a PostgreSQL system database. ` +
        `Migrations would be applied to the cluster's own catalog database.`,
    );
  }

  const collisions = [...new Set(input.protected_names.filter((name) => name.length > 0))];
  if (collisions.includes(database)) {
    throw new Error(
      `refusing to rehearse against ${database}: it is the database named by the configured ` +
        `DATABASE_URL or MIGRATION_DATABASE_URL. This command applies migrations, terminates a ` +
        `backend and rebuilds projections; the ordinary database is not a rehearsal target. ` +
        `Omit --rehearsal-url to have a uniquely named disposable database created instead.`,
    );
  }

  if (!database.includes("rehearsal")) {
    throw new Error(
      `refusing to rehearse against ${database}: a rehearsal target's name must contain ` +
        `"rehearsal" so that anyone reading pg_database, a connection log or this report can ` +
        `tell it was disposable. Rename the database, or omit --rehearsal-url to have one ` +
        `created as ${REHEARSAL_DATABASE_PREFIX}<timestamp>_<suffix>.`,
    );
  }

  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) {
    throw new Error(
      `refusing to rehearse against ${JSON.stringify(database)}: a rehearsal database name must ` +
        `be lowercase letters, digits and underscores and at most 63 characters. The name is ` +
        `interpolated into CREATE DATABASE, where a parameter placeholder is not available.`,
    );
  }

  return {
    database,
    url: input.url,
    protections: [
      `target name ${database} is not a PostgreSQL system database`,
      `target name ${database} differs from the configured working database(s) ` +
        `(${collisions.length === 0 ? "none configured" : collisions.join(", ")})`,
      `target name ${database} declares itself disposable by containing "rehearsal"`,
    ],
  };
}

/** A unique, self-describing name for a freshly created rehearsal database. */
export function rehearsalDatabaseName(now: Date, suffix: string): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "z")
    .toLowerCase();
  const name = `${REHEARSAL_DATABASE_PREFIX}${stamp}_${suffix.toLowerCase()}`;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`generated rehearsal database name ${JSON.stringify(name)} is not a legal identifier`);
  }
  return name;
}

export interface TargetInspection {
  readonly exists: boolean;
  /** Relations in `public` other than the marker table. */
  readonly foreign_relations: readonly string[];
  readonly marker_state: "absent" | "valid" | "invalid";
  readonly marker_detail: string | null;
  readonly marker_label: string | null;
  readonly marker_created_at: string | null;
}

/** Read what is actually in a candidate database. */
export async function inspectTarget(adminUrl: string, database: string): Promise<TargetInspection> {
  const existing = new Client({ connectionString: adminUrl });
  await existing.connect();
  try {
    const present = await existing.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present",
      [database],
    );
    if (present.rows[0]?.present !== true) {
      return {
        exists: false,
        foreign_relations: [],
        marker_state: "absent",
        marker_detail: null,
        marker_label: null,
        marker_created_at: null,
      };
    }
  } finally {
    await existing.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const marker = await client.query<{ present: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [`public.${REHEARSAL_MARKER_TABLE}`],
    );
    const markerPresent = marker.rows[0]?.present === true;
    const relations = await client.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND c.relname <> $1
        ORDER BY c.relname`,
      [REHEARSAL_MARKER_TABLE],
    );
    let markerState: TargetInspection["marker_state"] = "absent";
    let markerDetail: string | null = null;
    let label: string | null = null;
    let createdAt: string | null = null;
    if (markerPresent) {
      try {
        const columns = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
          `SELECT column_name, data_type, is_nullable
             FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1
            ORDER BY ordinal_position`,
          [REHEARSAL_MARKER_TABLE],
        );
        const expected = [
          ["label", "text", "NO"],
          ["created_at", "timestamp with time zone", "NO"],
          ["report_version", "text", "NO"],
        ];
        const schemaMatches =
          columns.rows.length === expected.length &&
          columns.rows.every((column, index) =>
            column.column_name === expected[index]?.[0] &&
            column.data_type === expected[index]?.[1] &&
            column.is_nullable === expected[index]?.[2],
          );
        if (!schemaMatches) {
          markerState = "invalid";
          markerDetail = "marker table has an unexpected schema";
        } else {
          const rows = await client.query<{ label: string; created_at: Date | string; report_version: string }>(
            `SELECT label, created_at, report_version FROM ${REHEARSAL_MARKER_TABLE} ORDER BY created_at`,
          );
          const row = rows.rows[0];
          label = row?.label ?? null;
          createdAt = row === undefined ? null : new Date(row.created_at).toISOString();
          if (
            rows.rows.length === 1 &&
            row?.label === REHEARSAL_MARKER_SENTINEL &&
            row.report_version === REHEARSAL_MARKER_VERSION &&
            createdAt !== null &&
            !Number.isNaN(new Date(createdAt).getTime())
          ) {
            markerState = "valid";
          } else {
            markerState = "invalid";
            markerDetail = "marker row is missing, duplicated, or belongs to a different tool version";
          }
        }
      } catch (error) {
        markerState = "invalid";
        markerDetail = `marker could not be validated: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return {
      exists: true,
      foreign_relations: relations.rows.map((row) => row.relname),
      marker_state: markerState,
      marker_detail: markerDetail,
      marker_label: label,
      marker_created_at: createdAt,
    };
  } finally {
    await client.end();
  }
}

/**
 * A selected database may be reused only when it is empty of our objects or already marked
 * as a rehearsal database. Anything else is somebody's data.
 */
export function assertSelectableTarget(inspection: TargetInspection, database: string): void {
  if (!inspection.exists) return;
  if (inspection.marker_state === "invalid") {
    throw new Error(
      `refusing to reuse database ${database}: ${REHEARSAL_MARKER_TABLE} exists but is not a valid ` +
        `VM-A2 ownership marker (${inspection.marker_detail ?? "unknown marker defect"}).`,
    );
  }
  if (inspection.marker_state === "valid") return;
  if (inspection.foreign_relations.length === 0) return;
  throw new Error(
    `refusing to reuse database ${database}: it has no ${REHEARSAL_MARKER_TABLE} marker but holds ` +
      `${inspection.foreign_relations.length} relation(s) in public (${inspection.foreign_relations
        .slice(0, 8)
        .join(", ")}${inspection.foreign_relations.length > 8 ? ", …" : ""}). A rehearsal database ` +
      `must be empty of unknown objects. Use a different name, or drop this database yourself.`,
  );
}
