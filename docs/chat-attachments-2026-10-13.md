# Attaching documents in chat — October 13, 2026

**Before.** Chat with Atlas had no way to send a file. A document had to be added on the Sources tab first, and the next reply saw it only as one more entry in the source updates, with nothing tying it to the message that asked about it.

**Now.** The chat composer has **Attach document** (and accepts files dropped on it). Up to five PDF, HTML or plain-text files go with one message.

## Design

- **One upload path.** Choosing a file posts it to the existing `POST /api/projects/:id/documents` route, the same one the Sources form uses. Text extraction, the 50 MB limit, refusal of Word and scanned PDFs, content-addressed identity and the Activity event are unchanged. The file joins the source register as soon as it is chosen. Adding a document is free, and the document stays in Sources even if the message is never sent.
- **The message carries IDs, not files.** `POST /api/projects/:id/chat` accepts an optional `attachments` array of source IDs. `attachedDocuments` in `lib/chat.mjs` accepts at most `CHAT_LIMITS.attachments` (5) distinct IDs. Each one must be a source of kind `upload` in the same project; anything else is refused with a 400, as is an attachment sent with an Ask Atlas `questionId`. The validated `{sourceId, title}` pairs are saved in a new `chat_turns.attachments` column (JSON, default `[]`, added by migration).
- **What the model sees.** `userText` adds `Documents I attached to this message (saved in this project as sources of kind upload; read them with read_saved_source):` and the JSON list after the message text. It does this in the latest message and in that turn's history in later replies. The note comes from saved data, so the cached history stays byte-identical between replies. Turns without attachments, including every turn saved before this change, produce exactly the text they did before. A newly added document's text still reaches the reply through the existing source-update tail.
- **Idempotency.** A repeated send with the same `clientId` must name the same documents in the same order; otherwise it is refused like a changed message.
- **UI.** Attachments for each project's unsent message live in page memory beside its draft. **Send message** stays disabled while files are being added. Sending clears the list. The sent message shows each attachment as a link to its Sources card. **Try again** on a declined reply sends the same attachments.

## Verification

- `node --test tests/chat.test.mjs` includes validation, saving with the message, the note in the latest message and in later history, document text in the payload, idempotency, and project isolation.
- `node tests/chat-ui.mjs` includes a refused Word file, choosing a file, dropping a file, removing an attachment while keeping its source, sending, the payload note, the sent message's link to Sources, reload, and the mobile layout.
