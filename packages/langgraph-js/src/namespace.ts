/**
 * Namespace ↔ scope translation.
 *
 * LangGraph's store API addresses data with `string[]` namespaces. VerityMem's
 * ownership boundary is a *scope*, which is six independent dimensions — tenant,
 * project, user, agent, session and purpose — and the specification is explicit
 * that concatenating them into one opaque namespace string is "how purpose and
 * tenant boundaries get lost".
 *
 * So this module never concatenates. A namespace is either a tuple of explicitly
 * named dimensions (`["tenant:acme", "project:payments", "purpose:release_planning"]`)
 * or a positional tuple whose dimension order the caller declared
 * (`createNamespaceCodec({ dimensions: ["tenant", "project", "purpose"] })`). Anything
 * else throws: there is no fallback to a string key, because the fallback is the
 * bug.
 *
 * The codec is pure and dependency-free on purpose. Tenant scoping and purpose
 * scoping are the two boundary properties a red team will attack first, so the
 * mapping must be testable without a database, without a graph, and without the
 * optional LangChain peer installed.
 */

/** Every dimension of a VerityMem scope, in canonical order. */
export const SCOPE_DIMENSIONS = ["tenant", "project", "user", "agent", "session", "purpose"] as const;

export type ScopeDimension = (typeof SCOPE_DIMENSIONS)[number];

/**
 * The dimensions that bind a scope to something narrower than a tenant.
 *
 * Migration 0001 requires at least one of these on every scope row. A scope with
 * none of them is a tenant-wide scope in disguise, and tenant-wide is how
 * accidental disclosure happens, so the codec applies the same rule client-side.
 */
export const BOUND_DIMENSIONS = ["project", "user", "agent", "session"] as const;

export type BoundDimension = (typeof BOUND_DIMENSIONS)[number];

export const TENANT_DIMENSION = "tenant" as const;
export const PURPOSE_DIMENSION = "purpose" as const;

/** Separates a dimension name from its value inside one namespace segment. */
export const DIMENSION_SEPARATOR = ":";

/**
 * Characters a dimension value may not contain.
 *
 * They are the separators an opaque concatenated namespace would use, and no
 * VerityMem scope value legitimately needs them: tenant slugs, project slugs,
 * principal ids, session ids and purpose names are all identifier-like. Rejecting
 * them is what stops `["acme/payments/alice"]` from being read as three dimensions
 * or as one.
 */
export const FORBIDDEN_VALUE_CHARACTERS = ["/", "|"] as const;

/** A resolved scope: explicit dimensions, at least one purpose. */
export interface StoreScope {
  readonly tenant: string;
  readonly project?: string;
  readonly user?: string;
  readonly agent?: string;
  readonly session?: string;
  /** The purposes this scope was admitted for. Purpose is a boundary, not a tag. */
  readonly purpose: readonly string[];
}

/**
 * A partially specified scope.
 *
 * Search takes a *prefix*: a caller may legitimately search everything reachable
 * in a tenant for one purpose. Writes may not: `toScope` is the strict form and
 * requires a bound dimension, while this form only requires a tenant.
 */
export interface StoreScopePrefix {
  readonly tenant: string;
  readonly project?: string;
  readonly user?: string;
  readonly agent?: string;
  readonly session?: string;
  readonly purpose?: readonly string[];
}

export interface NamespaceCodecOptions {
  /**
   * Dimension order used to read namespaces written as bare positional values
   * (`["acme", "payments"]`). Optional: without it, only explicitly named
   * dimensions are accepted.
   */
  readonly dimensions?: readonly ScopeDimension[];
}

export interface NamespaceCodec {
  /** The positional order this codec accepts for bare namespaces. */
  readonly dimensions: readonly ScopeDimension[];
  /**
   * Scope → canonical namespace. Named segments in canonical dimension order,
   * purposes sorted, so the same scope always produces the same namespace.
   */
  toNamespace(scope: StoreScope): string[];
  /** Namespace → full scope. Throws unless tenant, a bound dimension and a purpose are named. */
  toScope(namespace: readonly string[]): StoreScope;
  /** Namespace → partial scope for a search prefix. Throws unless a tenant is named. */
  toScopePrefix(namespace: readonly string[]): StoreScopePrefix;
}

interface DecodedSegment {
  readonly keyed: boolean;
  readonly dimension?: ScopeDimension;
  readonly value: string;
}

/**
 * Build the codec the store uses.
 *
 * Exists so the namespace rules are a value a caller can hold, assert against and
 * pass to a graph, rather than a convention spread across call sites. Two codecs
 * with different dimension orders must not be able to read each other's data
 * silently, and a codec with no positional order refuses bare namespaces outright.
 */
export function createNamespaceCodec(options: NamespaceCodecOptions = {}): NamespaceCodec {
  const dimensions = Object.freeze([...(options.dimensions ?? SCOPE_DIMENSIONS)]);
  assertDimensionsUsable(dimensions);

  return {
    dimensions,
    toNamespace(scope: StoreScope): string[] {
      return namespaceFromScope(scope, dimensions);
    },
    toScope(namespace: readonly string[]): StoreScope {
      const decoded = decode(namespace, dimensions);
      return {
        tenant: requireDimension(decoded, TENANT_DIMENSION, namespace),
        ...optionalDimensions(decoded, namespace),
        purpose: requirePurposes(decoded, namespace),
      };
    },
    toScopePrefix(namespace: readonly string[]): StoreScopePrefix {
      const decoded = decode(namespace, dimensions);
      const purposes = decoded.get(PURPOSE_DIMENSION);
      return {
        tenant: requireDimension(decoded, TENANT_DIMENSION, namespace),
        ...optionalDimensions(decoded, namespace),
        ...(purposes === undefined ? {} : { purpose: [...purposes] }),
      };
    },
  };
}

/**
 * Scope → namespace without a codec instance.
 *
 * Exported because the *write* side of a namespace often lives in application code
 * that already knows its own scope shape, and forcing that code to construct a
 * codec invites it to hand-build the array instead.
 */
export function namespaceFromScope(
  scope: StoreScope,
  dimensions: readonly ScopeDimension[] = SCOPE_DIMENSIONS,
): string[] {
  assertDimensionsUsable(dimensions);
  const out: string[] = [];
  for (const dimension of dimensions) {
    if (dimension === PURPOSE_DIMENSION) continue;
    const value = scope[dimension];
    if (value === undefined || value === null) continue;
    assertValue(value, dimension, []);
    out.push(`${dimension}${DIMENSION_SEPARATOR}${value}`);
  }

  const purposes = [...scope.purpose];
  if (purposes.length === 0 && dimensions.includes(PURPOSE_DIMENSION)) {
    throw new NamespaceMappingError(
      "missing_dimension",
      out,
      "a scope with no purpose is unreachable by design: purpose is a hard boundary, not a wildcard. " +
        "Declare at least one purpose on the scope before turning it into a namespace",
    );
  }
  if (dimensions.includes(PURPOSE_DIMENSION)) {
    assertAtLeastOneBoundDimension(scope, out);
    for (const purpose of [...purposes].sort()) {
      assertValue(purpose, PURPOSE_DIMENSION, out);
      out.push(`${PURPOSE_DIMENSION}${DIMENSION_SEPARATOR}${purpose}`);
    }
  }
  return out;
}

/**
 * Transport encoding for peers whose store interface is string-keyed.
 *
 * LangChain's older `BaseStore<string, V>` has no namespace parameter at all. The
 * encoding keeps the dimensions *named* (`tenant=acme|project=payments|key=deploy-window`)
 * so it parses back into explicit dimensions and rejects anything that does not
 * name its tenant and purpose. It is a wire format for an interface that only
 * speaks strings — not a licence to concatenate scopes.
 */
export function encodeStoreKey(namespace: readonly string[], key: string): string {
  if (namespace.length === 0) {
    throw new NamespaceMappingError("empty_namespace", namespace, "cannot encode a store key with no namespace");
  }
  assertValue(key, "key", namespace);
  return `${namespace.join("|")}|key=${key}`;
}

/** Inverse of {@link encodeStoreKey}. Throws on anything that does not name its dimensions. */
export function decodeStoreKey(
  encoded: string,
  codec: NamespaceCodec,
): { readonly namespace: string[]; readonly key: string } {
  const parts = encoded.split("|");
  const last = parts[parts.length - 1];
  if (last === undefined || !last.startsWith("key=")) {
    throw new NamespaceMappingError(
      "opaque_segment",
      [encoded],
      `store key ${JSON.stringify(encoded)} does not end in "|key=<key>". A string-keyed store key must ` +
        "encode explicit scope dimensions, never an opaque concatenation",
    );
  }
  const namespace = parts.slice(0, -1);
  // Validates the dimensions rather than trusting them, and supplies the message
  // for a namespace that was assembled by hand.
  codec.toScope(namespace);
  return { namespace, key: last.slice("key=".length) };
}

function assertDimensionsUsable(dimensions: readonly ScopeDimension[]): void {
  const seen = new Set<string>();
  for (const dimension of dimensions) {
    if (seen.has(dimension)) {
      throw new NamespaceMappingError(
        "duplicate_dimension",
        [],
        `namespace codec declares dimension "${dimension}" twice; a dimension named twice cannot be read back unambiguously`,
      );
    }
    seen.add(dimension);
  }
  // A positional order without these two produces namespaces that the same codec
  // cannot read back, which would surface as an unexplained failure on the read
  // path rather than as a configuration error here.
  for (const required of [TENANT_DIMENSION, PURPOSE_DIMENSION]) {
    if (!seen.has(required)) {
      throw new NamespaceMappingError(
        "missing_dimension",
        [],
        `namespace codec must declare "${required}": namespaces must be readable back into a tenant-bound, ` +
          "purpose-bound scope, and a codec that cannot do that is misconfigured rather than permissive",
      );
    }
  }
}

function decode(namespace: readonly string[], dimensions: readonly ScopeDimension[]): Map<string, string[]> {
  if (namespace.length === 0) {
    throw new NamespaceMappingError(
      "empty_namespace",
      namespace,
      "empty namespace: an unbound namespace cannot name a tenant, and every VerityMem read is tenant-bound",
    );
  }
  if (namespace.length > 64) {
    throw new NamespaceMappingError(
      "opaque_segment",
      namespace,
      `namespace has ${namespace.length} segments; scope has six dimensions, so a longer namespace is not a scope`,
    );
  }

  const segments = namespace.map((segment) => decodeSegment(segment, namespace));
  const keyed = segments.filter((segment) => segment.keyed).length;
  if (keyed !== 0 && keyed !== segments.length) {
    throw new NamespaceMappingError(
      "mixed_encoding",
      namespace,
      "namespace mixes named segments with bare positional values; use either " +
        '["tenant:acme", "project:payments", "purpose:release_planning"] or a positional tuple with a declared order',
    );
  }

  const decoded = new Map<string, string[]>();
  if (keyed === 0) {
    if (dimensions.length !== segments.length) {
      throw new NamespaceMappingError(
        "positional_length_mismatch",
        namespace,
        `namespace has ${segments.length} segment(s) but the codec declares ${dimensions.length} positional ` +
          `dimension(s) [${dimensions.join(", ")}]. A namespace whose segments do not line up with named ` +
          "dimensions is opaque: name each segment explicitly, e.g. " +
          `"tenant${DIMENSION_SEPARATOR}acme"`,
      );
    }
    segments.forEach((segment, index) => {
      const dimension = dimensions[index];
      if (dimension === undefined) return;
      assertValue(segment.value, dimension, namespace);
      push(decoded, dimension, segment.value);
    });
    return decoded;
  }

  for (const segment of segments) {
    const dimension = segment.dimension;
    if (dimension === undefined) continue;
    assertValue(segment.value, dimension, namespace);
    if (dimension !== PURPOSE_DIMENSION && (decoded.get(dimension)?.length ?? 0) > 0) {
      throw new NamespaceMappingError(
        "duplicate_dimension",
        namespace,
        `dimension "${dimension}" appears twice in one namespace; only "purpose" may repeat`,
      );
    }
    push(decoded, dimension, segment.value);
  }
  return decoded;
}

function decodeSegment(segment: string, namespace: readonly string[]): DecodedSegment {
  if (segment.trim() !== segment || segment.length === 0) {
    throw new NamespaceMappingError(
      "empty_value",
      namespace,
      `namespace segment ${JSON.stringify(segment)} is empty or padded with whitespace`,
    );
  }
  const separator = segment.indexOf(DIMENSION_SEPARATOR);
  if (separator < 0) {
    for (const forbidden of FORBIDDEN_VALUE_CHARACTERS) {
      if (segment.includes(forbidden)) {
        throw new NamespaceMappingError(
          "concatenated_value",
          namespace,
          `namespace segment ${JSON.stringify(segment)} contains ${JSON.stringify(forbidden)}, which is the ` +
            "separator a concatenated namespace would use. Split it into explicit dimensions, e.g. " +
            '"tenant:acme", "project:payments"',
        );
      }
    }
    return { keyed: false, value: segment };
  }

  const name = segment.slice(0, separator);
  const value = segment.slice(separator + 1);
  if (!isScopeDimension(name)) {
    throw new NamespaceMappingError(
      "opaque_segment",
      namespace,
      `namespace segment ${JSON.stringify(segment)} names dimension ${JSON.stringify(name)}, which is not one of ` +
        `[${SCOPE_DIMENSIONS.join(", ")}]. A segment that does not name its dimension is an opaque key, and an ` +
        "opaque key loses the tenant and purpose boundaries",
    );
  }
  return { keyed: true, dimension: name, value };
}

function isScopeDimension(value: string): value is ScopeDimension {
  return (SCOPE_DIMENSIONS as readonly string[]).includes(value);
}

function assertValue(value: string, dimension: string, namespace: readonly string[]): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new NamespaceMappingError(
      "empty_value",
      namespace,
      `${dimension} is empty. An unnamed dimension is not "any": for purpose it means unreachable, and for a ` +
        "tenant it means the read is not bound at all",
    );
  }
  if (value.length > 256) {
    throw new NamespaceMappingError(
      "empty_value",
      namespace,
      `${dimension} value is ${value.length} characters; scope values are bounded at 256`,
    );
  }
  for (const forbidden of FORBIDDEN_VALUE_CHARACTERS) {
    if (value.includes(forbidden)) {
      throw new NamespaceMappingError(
        "concatenated_value",
        namespace,
        `${dimension} value ${JSON.stringify(value)} contains ${JSON.stringify(forbidden)}; scope values are ` +
          "identifier-like and a separator inside a value is how two dimensions become one opaque string",
      );
    }
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new NamespaceMappingError(
        "empty_value",
        namespace,
        `${dimension} value contains a control character (U+${code.toString(16).padStart(4, "0")}); control ` +
          "characters in a namespace are how a delimiter is forged",
      );
    }
  }
}

function push(map: Map<string, string[]>, dimension: string, value: string): void {
  const existing = map.get(dimension);
  if (existing === undefined) map.set(dimension, [value]);
  else existing.push(value);
}

function requireDimension(
  decoded: Map<string, string[]>,
  dimension: ScopeDimension,
  namespace: readonly string[],
): string {
  const values = decoded.get(dimension);
  const value = values?.[0];
  if (value === undefined) {
    throw new NamespaceMappingError(
      "missing_dimension",
      namespace,
      `namespace does not name "${dimension}". A namespace without a tenant is not an ambiguous question, it is ` +
        "the wrong question, so it is refused rather than defaulted",
    );
  }
  return value;
}

function requirePurposes(decoded: Map<string, string[]>, namespace: readonly string[]): string[] {
  const purposes = decoded.get(PURPOSE_DIMENSION);
  if (purposes === undefined || purposes.length === 0) {
    throw new NamespaceMappingError(
      "missing_dimension",
      namespace,
      `namespace does not name a "${PURPOSE_DIMENSION}". Purpose is a hard boundary: a write with no purpose is ` +
        "unreachable by every later read, and a read with no purpose cannot be authorized",
    );
  }
  return [...purposes].sort();
}

function optionalDimensions(
  decoded: Map<string, string[]>,
  namespace: readonly string[],
): Omit<StoreScopePrefix, "tenant" | "purpose"> {
  const out: {
    project?: string;
    user?: string;
    agent?: string;
    session?: string;
  } = {};
  for (const dimension of BOUND_DIMENSIONS) {
    const value = decoded.get(dimension)?.[0];
    if (value === undefined) continue;
    out[dimension] = value;
  }
  void namespace;
  return out;
}

function assertAtLeastOneBoundDimension(scope: StoreScope, namespace: readonly string[]): void {
  for (const dimension of BOUND_DIMENSIONS) {
    if (scope[dimension] !== undefined && scope[dimension] !== null) return;
  }
  throw new NamespaceMappingError(
    "unbound_scope",
    namespace,
    `scope binds none of [${BOUND_DIMENSIONS.join(", ")}], so it is a tenant-wide scope in disguise. ` +
      "Migration 0001 refuses such a row; the codec refuses it before the write reaches the ledger",
  );
}
