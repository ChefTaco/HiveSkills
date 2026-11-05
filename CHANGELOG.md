# Changelog

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
