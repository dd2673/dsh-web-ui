export type RespondResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details?: unknown } }
