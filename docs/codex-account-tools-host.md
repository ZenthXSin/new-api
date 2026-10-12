# New API account tools and administrator host projects

New conversations register `newapi_list_tools` and `newapi_call_tool` as native
App Server dynamic tools. Discovering the catalog loads the operation schemas
only when needed. Existing native threads retain their history and runtime tool
registration; start a new conversation to use this feature on a legacy project.

The catalog covers personal profile, notification/language/sidebar/logging
preferences, available groups/models, effective Codex grants, API token
management, subscriptions/billing preference, wallet information, check-in,
usage and security status. Security verification, credential reveal and payment
operations return links to the existing first-party pages. Browser-local Codex
preferences are changed in Codex settings. Administrator site configuration is
not part of this own-account catalog.

Code mode pauses mutating account tools for approval. Auto approve and full
access execute approved-scope tools directly; Ask mode rejects changes. The
backend permits only named operations and bounded fields, preserves existing
settings during partial updates, invokes existing ownership checks, and redacts
credential fields from results.

Tool credentials (`nact_`) use a separate signing purpose/audience from model
relay credentials (`nacx_`) and dashboard access tokens. They stay in runner
memory and expire after six hours. Every invocation checks the live browser
session, account status and effective Codex entitlement. Logout/revocation or
loss of the Codex grant invalidates the credential. A new authenticated request
refreshes authorization; closing the browser does not interrupt server work.

Administrators can select **Host** in the environment picker or create a host
project from the project dialog. A host project connects to an existing absolute
directory. Host access is derived from the current database role, not a plan,
manual resource override, request body or browser preference. API, runner and
startup checks prevent ordinary users from executing commands or accessing live
host files. Existing owner-scoped conversation history remains readable.

Production host operations use transient systemd services. This starts work
outside the control runner's ProtectHome/ProtectSystem/PrivateTmp namespace
without changing Docker isolation. Model/GitHub credentials travel through
stdin, never transient-unit arguments. The default host project mode is full
access. Explicit Ask mode still requests the native read-only policy. Processes
are tracked per conversation, canceled independently and cleaned up on restart.
Removing a workbench project preserves its host files. Docker resource quotas
apply to Docker projects rather than host directories.
