# Changelog

## 1.3.1 - 2026-11-05

### Security

- Remove npm, npx, corepack and yarn and the apt package tooling (apt,
  libapt-pkg6.0) from the runtime image; the service never invokes a package
  manager at runtime. This drops the bundled npm's brace-expansion 5.0.9
  (CVE-2026-102276, CVE-2026-102278) and undici 6.28.0 (CVE-2026-19534,
  CVE-2026-109383, CVE-2026-109869, CVE-2026-87018) and apt 2.6.1
  (CVE-2026-109518). dpkg and its package database remain so scanners can still
  inventory OS packages. The image has no HIGH or CRITICAL finding with an
  available fix (Trivy 0.70.0).
- HIGH and CRITICAL findings in Debian 12 base packages that have no fix yet:
  zlib1g CVE-2023-45853 (critical) and CVE-2026-76844; util-linux and its
  libraries CVE-2026-53613, CVE-2026-53615 and CVE-2026-78410; ncurses
  CVE-2025-69720; libsystemd0 and libudev1 CVE-2026-16742; gzip CVE-2026-41992;
  libacl1 CVE-2026-54369; perl-base CVE-2026-9538.

## 1.3.0 - 2026-11-05

- Export standalone product-owned browser validators, including exact request bounds, enrollment credentials and deployment responses. Validate administration writes against those same contracts and omit private archive paths from release creation replies.

- Export reviewed public native client archives with exact file/runtime digests and preserved license notices for publisher-signed installer staging.

- Revalidate native target authorization and the exact approved assignment before frozen deployments touch profile state. Disabled targets cannot approve or begin queued work.

- Add exact publication deployment previews, expiring one-use approvals, durable Magnus job references and receipt-only recovery. Suite deployments no longer execute the legacy SSH helper; interrupted jobs stay unknown until reviewed.

### Ecosystem extraction

Add browser-safe release history and bounded audit APIs with owned OpenAPI contracts.
Rehearsals and explicitly disabled deployment workers preserve queued and running jobs without recovering or dispatching them.

Independent product snapshot, container build and direct Oathweave authorization with explicit product-account links. Existing machine protocols remain available. Suite lifecycle and migration acceptance remain pending.

Browser skill deployment requests remain unavailable until the authenticated Magnus job adapter is configured. Native compatibility and registry reads remain available. Containers bind their service listener explicitly.
