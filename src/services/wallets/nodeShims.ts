// Minimal Node globals some NEAR wallet SDKs expect (Meteor reads `process.env`
// and `Buffer` at import time). Imported only right before those SDKs load, so
// the rest of the app never ships these shims.
import { Buffer } from 'buffer';

const scope = globalThis as unknown as { Buffer?: typeof Buffer; process?: { env?: Record<string, string | undefined> } };
scope.Buffer ??= Buffer;
scope.process ??= { env: {} };
scope.process.env ??= {};

export {};
