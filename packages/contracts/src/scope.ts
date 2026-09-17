/**
 * Scope is the ownership boundary, and purpose is a first-class member of it.
 *
 * There are deliberately two shapes:
 *   - `ScopeRef`      — a concrete, already-resolved scope in the store (has an id).
 *   - `ScopeSelector` — a query-time filter. A selector is matched against refs by
 *                       dimension: a null dimension means "any", which is why a
 *                       selector may be wider than any single ref.
 *
 * A `ScopeSelector` always names a tenant. An application that omits the tenant is
 * not asking an ambiguous question; it is asking the wrong one.
 */
import { type Static, Type } from "@sinclair/typebox";
import { InstantSchema, UuidSchema } from "./primitives.ts";

export const TenantIdSchema = Type.String({ minLength: 1, maxLength: 128 });
export type TenantId = Static<typeof TenantIdSchema>;

export const PurposeSchema = Type.String({ minLength: 1, maxLength: 128 });
export type Purpose = Static<typeof PurposeSchema>;

/**
 * A resolved scope. At least one of project/user/agent/session must bind — see the
 * `scopes_must_bind_something` check in migration 0001. An unbound scope is a
 * tenant-wide scope in disguise, and tenant-wide is how accidental disclosure happens.
 */
export const ScopeRefSchema = Type.Object(
  {
    scope_id: UuidSchema,
    tenant: TenantIdSchema,
    project: Type.Union([Type.String(), Type.Null()]),
    user: Type.Union([Type.String(), Type.Null()]),
    agent: Type.Union([Type.String(), Type.Null()]),
    session: Type.Union([Type.String(), Type.Null()]),
    purpose: Type.Array(PurposeSchema),
  },
  { $id: "ScopeRef", additionalProperties: false },
);
export type ScopeRef = Static<typeof ScopeRefSchema>;

/** Query-time scope filter. Null dimensions are wildcards. */
export const ScopeSelectorSchema = Type.Object(
  {
    tenant: TenantIdSchema,
    project: Type.Optional(Type.String()),
    user: Type.Optional(Type.String()),
    agent: Type.Optional(Type.String()),
    session: Type.Optional(Type.String()),
  },
  { $id: "ScopeSelector", additionalProperties: false },
);
export type ScopeSelector = Static<typeof ScopeSelectorSchema>;

/** The scope a write is admitted into, with the purpose it is admitted for. */
export const WriteScopeSchema = Type.Object(
  {
    tenant: TenantIdSchema,
    project: Type.Optional(Type.String()),
    user: Type.Optional(Type.String()),
    agent: Type.Optional(Type.String()),
    session: Type.Optional(Type.String()),
    purpose: Type.Array(PurposeSchema, {
      minItems: 1,
      description:
        "Purposes this write is admitted for. A claim admitted for release_planning is not thereby available for hr_review.",
    }),
  },
  { $id: "WriteScope", additionalProperties: false },
);
export type WriteScope = Static<typeof WriteScopeSchema>;

/** A time-bounded authorization from one principal to another. */
export const GrantSchema = Type.Object(
  {
    grant_id: Type.String(),
    tenant: TenantIdSchema,
    subject: Type.String({ description: "Principal or group receiving access." }),
    resource_pattern: ScopeSelectorSchema,
    actions: Type.Array(Type.String()),
    purpose: Type.Array(PurposeSchema),
    created_at: InstantSchema,
    expires_at: Type.Union([InstantSchema, Type.Null()]),
  },
  { $id: "Grant", additionalProperties: false },
);
export type Grant = Static<typeof GrantSchema>;

export const GrantCreateRequestSchema = Type.Object(
  {
    subject: Type.String({ minLength: 1 }),
    resource_pattern: ScopeSelectorSchema,
    actions: Type.Array(Type.String(), { minItems: 1 }),
    purpose: Type.Array(PurposeSchema, { minItems: 1 }),
    expires_at: Type.Optional(InstantSchema),
  },
  { $id: "GrantCreateRequest", additionalProperties: false },
);
export type GrantCreateRequest = Static<typeof GrantCreateRequestSchema>;
