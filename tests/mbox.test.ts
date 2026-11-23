// Run with: npm test  (node --test, no extra dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { isMboxSeparator, splitMbox } from "../shared/mbox.ts";

async function messages(text: string, chunkSize?: number): Promise<string[]> {
	const blob = new Blob([text]);
	const out: string[] = [];
	for await (const r of splitMbox(blob, chunkSize)) {
		out.push(await blob.slice(r.start, r.end).text());
	}
	return out;
}

const SEP1 = "From alice@example.com Mon Jan  1 10:00:00 2024\n";
const SEP2 = "From MAILER-DAEMON Tue Feb 13 09:05:59 2024\n";
const M1 = "Subject: one\nMessage-ID: <1@x>\n\nHello\n\n";
const M2 = "Subject: two\n\nFrom the top, this line is body text.\nFrom now on in 2024\n\n";
const M3 = "Subject: three\n\nLast\n";

test("separator matching", () => {
	assert.ok(isMboxSeparator("From alice@example.com Mon Jan  1 10:00:00 2024"));
	assert.ok(isMboxSeparator("From alice@example.com Mon Jan  1 10:00:00 2024\r"));
	assert.ok(isMboxSeparator("From - Sat Mar 02 23:59:01 +0000 2024"));
	assert.ok(!isMboxSeparator("From the top, this line is body text."));
	assert.ok(!isMboxSeparator("From now on in 2024"));
	assert.ok(!isMboxSeparator("From: alice@example.com"));
});

test("splits messages and ignores body lines starting with From", async () => {
	const got = await messages(SEP1 + M1 + SEP2 + M2 + SEP1 + M3);
	assert.deepEqual(got, [M1, M2, M3]);
});

test("same result at every chunk size", async () => {
	// Bodies of varying length so separators land on every offset near a chunk boundary.
	const expected: string[] = [];
	let text = "";
	for (let n = 0; n < 40; n++) {
		const body = `Subject: ${n}\n\n${"x".repeat(n * 37)}\nFrom here on\n\n`;
		expected.push(body);
		text += (n % 2 ? SEP1 : SEP2) + body;
	}
	for (let size = 1024; size < 1024 + 600; size += 7) {
		assert.deepEqual(await messages(text, size), expected, `chunk size ${size}`);
	}
});

test("handles CRLF line endings", async () => {
	const crlf = (s: string) => s.replace(/\n/g, "\r\n");
	const got = await messages(crlf(SEP1 + M1 + SEP2 + M3));
	assert.deepEqual(got, [crlf(M1), crlf(M3)]);
});

test("a file without separators is one message", async () => {
	assert.deepEqual(await messages(M1), [M1]);
	assert.deepEqual(await messages(""), []);
});

test("an .eml with a separator-like body line is one message", async () => {
	const eml = M1 + SEP1 + "More body\n";
	assert.deepEqual(await messages(eml), [eml]);
});

test("a file starting with an unrecognised From line throws", async () => {
	await assert.rejects(messages("From alice@example.com 2024-01-01T10:00:00Z\n" + M1), /Unrecognised mbox separator/);
});
