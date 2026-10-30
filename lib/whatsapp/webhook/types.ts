// Types shared by the webhook modules.

// Meta's webhook JSON as JSON.parse returns it: not validated against a
// schema, so every field of it is read defensively.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MetaJson = any;
