// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Select, Switch } from "@cloudflare/kumo";
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { getFolderDisplayName, Folders } from "shared/folders";
import { splitMbox, type MboxRange } from "shared/mbox";
import { useFolders } from "~/queries/folders";
import api, { ApiError } from "~/services/api";

const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const MAX_LISTED_FAILURES = 50;

interface Progress {
	phase: "scanning" | "importing" | "done" | "cancelled";
	total: number;
	imported: number;
	trimmed: number;
	duplicate: number;
	failed: number;
	failures: string[];
}

const formatSize = (bytes: number) =>
	bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

async function uploadWithRetry(mailboxId: string, message: Blob, params: Record<string, string>, signal: AbortSignal) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await api.importMessage(mailboxId, message, params, signal);
		} catch (e) {
			// 4xx means the message itself was rejected; retrying will not help.
			const permanent = e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429;
			if (permanent || signal.aborted || attempt >= MAX_ATTEMPTS) throw e;
			await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
		}
	}
}

export default function ImportMail({ mailboxId }: { mailboxId: string }) {
	const queryClient = useQueryClient();
	const { data: folders = [] } = useFolders(mailboxId);
	const [file, setFile] = useState<File | null>(null);
	const [folder, setFolder] = useState<string>(Folders.INBOX);
	const [markRead, setMarkRead] = useState(true);
	const [progress, setProgress] = useState<Progress | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	const running = progress?.phase === "scanning" || progress?.phase === "importing";
	const folderName = (id: string) => folders.find((f) => f.id === id)?.name || getFolderDisplayName(id);

	const start = async () => {
		if (!file) return;
		const abort = new AbortController();
		abortRef.current = abort;
		const state: Progress = { phase: "scanning", total: 0, imported: 0, trimmed: 0, duplicate: 0, failed: 0, failures: [] };
		const publish = () => setProgress({ ...state, failures: [...state.failures] });
		const fail = (index: number, range: MboxRange, reason: string) => {
			state.failed++;
			if (state.failures.length < MAX_LISTED_FAILURES) {
				state.failures.push(`Message ${index + 1} (${formatSize(range.end - range.start)}): ${reason}`);
			}
		};
		publish();

		try {
			const ranges: MboxRange[] = [];
			for await (const range of splitMbox(file)) {
				if (abort.signal.aborted) break;
				ranges.push(range);
				if (ranges.length % 500 === 0) {
					state.total = ranges.length;
					publish();
				}
			}
			state.total = ranges.length;
			state.phase = "importing";
			publish();

			const params = { folder, read: String(markRead) };
			let next = 0;
			const worker = async () => {
				while (!abort.signal.aborted) {
					const index = next++;
					if (index >= ranges.length) return;
					const range = ranges[index];
					if (range.end - range.start > MAX_MESSAGE_BYTES) {
						fail(index, range, "larger than 25 MB");
					} else {
						try {
							const { status } = await uploadWithRetry(mailboxId, file.slice(range.start, range.end), params, abort.signal);
							if (status === "duplicate") state.duplicate++;
							else state.imported++;
							if (status === "trimmed") state.trimmed++;
						} catch (e) {
							if (abort.signal.aborted) return;
							fail(index, range, e instanceof Error ? e.message : "upload failed");
						}
					}
					publish();
				}
			};
			await Promise.all(Array.from({ length: CONCURRENCY }, worker));
			state.phase = abort.signal.aborted ? "cancelled" : "done";
		} catch (e) {
			state.phase = "cancelled";
			state.failures.unshift(`Could not read the file: ${e instanceof Error ? e.message : "unknown error"}`);
		}
		publish();
		queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
		queryClient.invalidateQueries({ queryKey: ["folders", mailboxId] });
	};

	const processed = progress ? progress.imported + progress.duplicate + progress.failed : 0;

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-4">
				<DownloadSimpleIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">Import mail</span>
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				In Mail on your Mac, select a mailbox and choose Mailbox &gt; Export Mailbox. Then pick
				the <code>mbox</code> file inside the exported <code>.mbox</code> folder. A single{" "}
				<code>.eml</code> file also works. Imported mail keeps its original date and is not
				triaged, drafted or forwarded. Running the same import twice skips what is already here.
			</p>

			<div className="space-y-3">
				<input
					type="file"
					aria-label="Mailbox file"
					disabled={running}
					onChange={(e) => {
						setFile(e.target.files?.[0] ?? null);
						setProgress(null);
					}}
					className="block w-full text-xs text-kumo-default file:mr-3 file:rounded-md file:border file:border-kumo-line file:bg-kumo-recessed file:px-3 file:py-1.5 file:text-xs file:text-kumo-default"
				/>
				{file && <p className="text-xs text-kumo-subtle">{file.name}, {formatSize(file.size)}</p>}

				<div className="flex flex-wrap items-center gap-4">
					<div className="w-44">
						<Select
							aria-label="Import into folder"
							value={folder}
							disabled={running}
							renderValue={(v) => folderName(v as string)}
							onValueChange={(v) => {
								if (v) setFolder(v as string);
							}}
						>
							{folders.map((f) => (
								<Select.Option key={f.id} value={f.id}>
									{folderName(f.id)}
								</Select.Option>
							))}
						</Select>
					</div>
					<Switch label="Mark as read" checked={markRead} disabled={running} onCheckedChange={setMarkRead} />
				</div>

				<div className="flex items-center gap-2">
					<Button variant="primary" onClick={start} disabled={!file || running} loading={running}>
						Import
					</Button>
					{running && (
						<Button variant="ghost" onClick={() => abortRef.current?.abort()}>
							Cancel
						</Button>
					)}
				</div>
			</div>

			{progress && (
				<div className="mt-4 text-xs text-kumo-default" role="status">
					{progress.phase === "scanning" ? (
						<p>Reading file: {progress.total} messages found so far.</p>
					) : (
						<>
							<div className="h-1.5 w-full overflow-hidden rounded bg-kumo-recessed mb-2">
								<div
									className="h-full bg-kumo-brand"
									style={{ width: `${progress.total ? (processed / progress.total) * 100 : 100}%` }}
								/>
							</div>
							<p>
								{progress.phase === "done" ? "Finished. " : progress.phase === "cancelled" ? "Stopped. " : ""}
								{processed} of {progress.total} processed: {progress.imported} imported, {progress.duplicate}{" "}
								already present, {progress.failed} failed.
								{progress.trimmed > 0 && ` ${progress.trimmed} trimmed because the body was too large to store.`}
							</p>
						</>
					)}
					{progress.failures.length > 0 && (
						<ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-kumo-destructive">
							{progress.failures.map((f) => (
								<li key={f}>{f}</li>
							))}
							{progress.failed > progress.failures.length && (
								<li>and {progress.failed - progress.failures.length} more</li>
							)}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}
