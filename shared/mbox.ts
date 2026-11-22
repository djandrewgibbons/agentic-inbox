// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Finds message boundaries in an mbox file (e.g. Mail.app's
 * Mailbox > Export Mailbox) without loading the file into memory.
 *
 * Returns byte ranges, so callers can upload `file.slice(start, end)`.
 */

export interface MboxRange {
	/** First byte of the message (the line after the "From " separator). */
	start: number;
	/** One past the last byte of the message. */
	end: number;
}

const CHUNK_SIZE = 4 * 1024 * 1024;
/** Longest separator line we will consider. */
const MAX_SEPARATOR = 512;

// "From sender@example.com Mon Jan  1 00:00:00 2024". Body lines that start
// with "From " are not reliably escaped by Mail.app, so only the full
// asctime form counts as a separator.
const SEPARATOR =
	/^From \S*\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{1,2}:\d{2}(:\d{2})?\s+(\S+\s+)?\d{4}\s*$/;

const F = 0x46; // "F"
const LF = 0x0a;

export function isMboxSeparator(line: string): boolean {
	return SEPARATOR.test(line.replace(/\r$/, ""));
}

/**
 * Yield the byte range of every message in an mbox file.
 * A file with no separators is treated as one message (a plain .eml file).
 */
export async function* splitMbox(
	file: Blob,
	chunkSize: number = CHUNK_SIZE,
): AsyncGenerator<MboxRange> {
	const size = file.size;
	// A chunk must be able to hold a whole separator line.
	chunkSize = Math.max(chunkSize, MAX_SEPARATOR * 2);
	const decoder = new TextDecoder("latin1");
	let offset = 0;
	let atLineStart = true;
	let messageStart = -1;
	let found = false;

	while (offset < size) {
		const chunk = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
		const isLast = offset + chunk.length >= size;
		let next = offset + chunk.length;
		let i = 0;

		while (i < chunk.length) {
			if (atLineStart) {
				// A line that may run past this chunk is re-read at the start of the next one.
				if (!isLast && i > 0 && chunk.length - i < MAX_SEPARATOR) {
					next = offset + i;
					break;
				}
				if (chunk[i] === F) {
					const lineEnd = chunk.indexOf(LF, i);
					const end = lineEnd === -1 ? chunk.length : lineEnd;
					if (end - i <= MAX_SEPARATOR && isMboxSeparator(decoder.decode(chunk.subarray(i, end)))) {
						if (messageStart >= 0 && offset + i > messageStart) {
							yield { start: messageStart, end: offset + i };
						}
						found = true;
						messageStart = offset + Math.min(end + 1, chunk.length);
					}
				}
			}
			const lf = chunk.indexOf(LF, i);
			if (lf === -1) {
				atLineStart = false;
				break;
			}
			i = lf + 1;
			atLineStart = true;
		}
		offset = next;
	}

	if (found) {
		if (messageStart >= 0 && messageStart < size) yield { start: messageStart, end: size };
	} else if (size > 0) {
		yield { start: 0, end: size };
	}
}
