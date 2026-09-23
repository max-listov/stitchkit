# Voice

A live voice conversation with an agent repeats the same mechanics in every application
that has one: the reply is cut into sentences while the model is still writing it, each
sentence is stripped down to what can be said aloud, and a queue speaks them in order — and
stops at once when the listener interrupts. `stitchkit/voice` is those mechanics, the same in
the browser and on Bun or Node, with no dependencies. It is **evolving**.

Speech recognition, synthesis providers, the microphone and the player stay with the
application: the queue takes them as two functions.

## Sentences while the reply streams

```ts
import { SentenceCutter, SpeechQueue, speakableText } from 'stitchkit/voice'

const cutter = new SentenceCutter()

for await (const text of reply) {           // the whole reply so far, on every chunk
  for (const sentence of cutter.next(text, false)) say(sentence)
}
for (const sentence of cutter.next(finalText, true)) say(sentence) // the rest of the turn
cutter.reset()                              // the next turn starts from zero
```

A sentence ends at `. ! ? …` (with any closing quote or bracket) followed by whitespace and a
capital letter, a digit or an opening mark, or at a blank line between paragraphs. `3.5`,
`т. е. так` and `e.g. this` are not cut; the end of the text is not the end of a sentence
until `final`; nothing is cut inside a fenced code block, even one that is still open.

## What is said

`speakableText(markdown)` keeps what a reader sees and drops what cannot be said: headings,
emphasis and list markers lose their delimiters, a link keeps its text and loses its
address, and images, bare addresses, fenced code blocks and tables are dropped whole. It does
not summarise. A sentence that was only code becomes `''`, and the queue ignores blank text.

## Speaking in order, synthesising ahead

```ts
const queue = new SpeechQueue<Blob>({
  prepare: (text, signal) => synthesise(text, { signal }),  // the whole clip
  play: (clip, signal) => player.play(clip, { signal }),    // resolves when it has played
  lookahead: 1,                                             // the default
  onError: (error, text) => log.warn('sentence skipped', { error, text }),
  discard: (clip) => release(clip),                         // prepared, never played
})

const say = (sentence: string) => queue.push(speakableText(sentence))

// the turn is over: say what is queued, then `done` settles
queue.close()
// the listener interrupted: the playing sentence and every synthesis are aborted
queue.cancel()
await queue.done
```

While one sentence plays, up to `lookahead` more are already synthesising, so a synthesiser
that returns the whole clip does not leave a gap the length of its synthesis between two
sentences. `lookahead: 0` synthesises each sentence only after the previous one played.

A sentence that fails to synthesise or to play is reported to `onError` and skipped; the
queue goes on. `cancel()` aborts the signal of the sentence playing and of every synthesis in
flight, drops the rest, calls `discard` for every clip that was prepared and will not play,
and settles `done` without waiting for a `play` that ignores its signal. `isSpeaking` and
`isCancelled` say where the queue is.

## Phases

```ts
import { LIVE_VOICE_PHASES, type LiveVoicePhase } from 'stitchkit/voice'
// 'opening' | 'idle' | 'hearing' | 'thinking' | 'speaking'
```

One vocabulary for every side of the conversation — the server that runs the agent and the
page that shows the microphone — so a phase sent over the wire means the same on both ends.
