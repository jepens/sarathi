// Types shared by the webhook modules.

// Meta's webhook JSON as JSON.parse returns it: not validated against a
// schema. The handlers guard the fields Meta may leave out; a field they
// read directly (e.g. message.text.body) throws when it is missing, and the
// pipeline answers 500 so Meta retries.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MetaJson = any;
