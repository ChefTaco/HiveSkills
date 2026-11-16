# Direct browser authorization

The optional suite integration verifies RS256 credentials against explicit
`OATHWEAVE_ISSUER`, `OATHWEAVE_JWKS_URL` and `OATHWEAVE_USERINFO_URL` HTTPS
configuration. Configure all three together; the issuer is the browser issuer
selected in Oathweave, not an inferred native JWT issuer. TLS verification and
online session revocation are mandatory. Tokens have one exact product audience
and a maximum fifteen-minute lifetime. Permissions are not inferred from roles.
Native machine credentials and standalone authentication remain available.

Service (client-credentials) tokens are accepted only by `GET /v1/audit/export` and
need the `hiveskills:audit:read` permission; they need no account link. Oathweave signs
client-credentials tokens with its native issuer unless the client's policy selects the
browser issuer: list those native issuer identifiers (for example its `JWT_ISSUER`) in
the optional comma-separated `OATHWEAVE_NATIVE_ISSUERS`. A native issuer is accepted
for service tokens only, never for user tokens.

`HIVESKILLS_OATHWEAVE_IDENTITIES_JSON` is a protected JSON array of explicit account links:

```json
[{"issuer":"https://identity.example.com","subject":"example-subject","localId":"existing-product-identity"}]
```

`localId` means existing native username; registry administration also requires membership in HIVE_SKILLS_ADMIN_USERS. Unlinked subjects are denied.
Duplicate issuer/subject links, extra fields, and email-based mappings are rejected.
Do not put live links or credentials in Git. Prepare and review links independently
for each installation before applying configuration. No API request creates a
replacement identity to impersonate a legacy account.

Hive suite installations get this configuration from the suite controller. Before
switching an existing standalone installation from OS-account sign-in, rehearse a
restore and check permissions, native clients and the HiveXUI workflows; a passing
unit suite alone is not enough.

Browser-authorized deployment mutations remain unavailable until a Magnus job
adapter is configured. They cannot fall through to the retained native SSH worker.
Registry reads, immutable archives and assignments keep their product-owned APIs.
