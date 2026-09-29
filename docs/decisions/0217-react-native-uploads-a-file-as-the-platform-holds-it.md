---
title: "ADR 0217: React Native uploads a file as the platform holds it"
description: "In React Native onUploadProgress hands the platform XMLHttpRequest the body as the client built it and counts its upload events; an injected fetch there is refused; uploadInChunks reads any file with a size and a slice, not only a DOM Blob."
type: decision
status: accepted
created: 2026-09-29
updated: 2026-09-29
---

# ADR 0217 — React Native uploads a file as the platform holds it

## Context

ADR 0215 counts upload bytes in one of two places: a stream the transport
pulls, or `XMLHttpRequest` upload events in a browser. Both routes first
encode the body into bytes — `new Request(...).arrayBuffer()`. React Native
cannot take either:

- it has no streaming request body, so the stream route has nothing to send;
- a React Native file part is a `{ uri, name, type }` descriptor inside a
  `FormData`, which the platform streams from disk. Its fetch polyfill cannot
  read such a `FormData` back into bytes, and reading the file to count it is
  what the descriptor exists to avoid;
- the Ky client hands its fetch a `Request`, from which the original
  `FormData` is not recoverable at all.

The chunked driver of ADR 0216 took a DOM `Blob`. A platform file that is not
one — an Expo `File` has `size` and `slice`, and none of the rest of the `Blob`
type — could not be passed without a cast, so a consuming project's mobile
client kept its own copy of the part protocol.

## Decision

1. **A third route, `native-xhr`, chosen when `navigator.product ===
   'ReactNative'`.** The body goes to the platform's `XMLHttpRequest` as the
   client built it: the `FormData` object itself or the JSON string. The Ky
   client passes that body to the wrapper beside the `Request`, since it cannot
   be read back out of it. A `FormData`'s `content-type` is left to the
   platform, which writes its own boundary.
2. **`totalBytes` is known up front for a string or bytes, and comes with the
   first upload event for a `FormData`.** The first report is still `0` and
   the last still equals `totalBytes` — the `0` is emitted with the first
   total, before the first count.
3. **Credentials follow React Native's own fetch:** `include` and `omit` set
   `withCredentials`, anything else keeps the platform default. The browser
   route's refusal of `omit` does not apply — the platform can omit cookies.
4. **An injected fetch in React Native is refused with a `TypeError` at the
   call.** It would take the stream route, which the platform cannot send;
   silently bypassing the injected fetch would skip whatever it adds.
5. **`uploadInChunks` reads a `ChunkSource<TPart>`** — `size` and
   `slice(start, end): TPart` — and a part's `bytes` is what `slice` returned.
   A `Blob` satisfies it unchanged, so existing callers keep their types.

## Consequences

- A mobile client counts a part's upload through the same option as the web
  one, and drives parts through the same driver; its own copy of the protocol
  goes.
- The route is proven by a stand-in XHR in Bun that receives the body object,
  not by a device. A device check is the consuming project's: a part sent with
  `onUploadProgress` reports `0 → … → totalBytes`.
- Detection by `navigator.product` is what React Native sets; a web build of a
  React Native app runs in a browser and takes the browser route.
