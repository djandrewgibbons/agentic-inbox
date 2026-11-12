// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, Select, Switch, useKumoToastManager } from "@cloudflare/kumo";
import { RobotIcon, ArrowCounterClockwiseIcon, FunnelIcon } from "@phosphor-icons/react";
import {
	TRIAGE_ACTIONS,
	TRIAGE_CATEGORIES,
	TRIAGE_DESCRIPTIONS,
	TRIAGE_LABELS,
	parseRules,
	resolveTriageSettings,
	type TriageAction,
	type TriageCategory,
	type TriageSettings,
} from "shared/triage";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

const ACTION_LABELS: Record<TriageAction, string> = {
	inbox: "Keep in inbox",
	archive: "Archive",
	spam: "Spam",
	trash: "Trash",
};

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [triage, setTriage] = useState(() => resolveTriageSettings(undefined));
	const ruleErrors = useMemo(() => parseRules(triage.rules).errors, [triage.rules]);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
			setTriage(resolveTriageSettings(mailbox.settings?.triage));
		}
	}, [mailbox]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;
		setIsSaving(true);
		const settings = {
			...mailbox.settings,
			fromName: displayName,
			agentSystemPrompt: agentPrompt.trim() || undefined,
			triage: triage satisfies TriageSettings,
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved!" });
		} catch {
			toastManager.add({
				title: "Failed to save settings",
				variant: "error",
			});
		} finally {
			setIsSaving(false);
		}
	};

	const handleResetPrompt = () => {
		setAgentPrompt("");
	};

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>

			<div className="space-y-6">
				{/* Account */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-4">
						Account
					</div>
					<div className="space-y-3">
						<Input
							label="Display Name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label="Email" type="email" value={mailbox.email} disabled />
					</div>
				</div>

				{/* Smart triage */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center gap-2 mb-4">
						<FunnelIcon size={16} weight="duotone" className="text-kumo-subtle" />
						<span className="text-sm font-medium text-kumo-default">Smart triage</span>
						<Badge variant={triage.enabled ? "primary" : "secondary"}>{triage.enabled ? "On" : "Off"}</Badge>
					</div>
					<p className="text-xs text-kumo-subtle mb-4">
						New mail is sorted by your rules, then built-in sender rules, then AI. Mail from
						people you have written to always stays in the inbox. Drafts are saved for review
						and never sent automatically.
					</p>
					<div className="space-y-3 mb-5">
						<Switch
							label="Sort new mail automatically"
							checked={triage.enabled}
							onCheckedChange={(v) => setTriage((t) => ({ ...t, enabled: v }))}
						/>
						<Switch
							label="Use AI when no rule matches"
							checked={triage.useAI}
							onCheckedChange={(v) => setTriage((t) => ({ ...t, useAI: v }))}
						/>
					</div>

					<div className="divide-y divide-kumo-line border-y border-kumo-line mb-5">
						{TRIAGE_CATEGORIES.map((cat: TriageCategory) => (
							<div key={cat} className="flex flex-wrap items-center gap-3 py-2.5">
								<div className="min-w-0 flex-1 basis-56">
									<div className="text-sm text-kumo-default">{TRIAGE_LABELS[cat]}</div>
									<div className="text-xs text-kumo-subtle">{TRIAGE_DESCRIPTIONS[cat]}</div>
								</div>
								<div className="w-36">
									<Select
										aria-label={`${TRIAGE_LABELS[cat]} action`}
										value={triage.actions[cat]}
										renderValue={(v) => ACTION_LABELS[v as TriageAction]}
										onValueChange={(v) => {
											if (v) setTriage((t) => ({ ...t, actions: { ...t.actions, [cat]: v as TriageAction } }));
										}}
									>
										{TRIAGE_ACTIONS.map((a) => (
											<Select.Option key={a} value={a}>
												{ACTION_LABELS[a]}
											</Select.Option>
										))}
									</Select>
								</div>
								<Switch
									label="Draft reply"
									checked={triage.draftCategories.includes(cat)}
									onCheckedChange={(v) =>
										setTriage((t) => ({
											...t,
											draftCategories: v
												? [...new Set([...t.draftCategories, cat])]
												: t.draftCategories.filter((c) => c !== cat),
										}))
									}
								/>
							</div>
						))}
					</div>

					<div className="text-sm text-kumo-default mb-1">Your rules</div>
					<p className="text-xs text-kumo-subtle mb-2">
						One per line: <code>conditions =&gt; category [inbox|archive|spam|trash]</code>.
						Conditions are <code>from:</code>, <code>to:</code>, <code>subject:</code>,{" "}
						<code>body:</code>; quote values with spaces, use <code>/regex/</code> or <code>*</code>.
					</p>
					<textarea
						value={triage.rules}
						onChange={(e) => setTriage((t) => ({ ...t, rules: e.target.value }))}
						placeholder={`# examples\nfrom:@technovaapps.com => cold_outreach trash\nto:hostmaster@ subject:"contact information" => admin archive\nfrom:@bandsintown.com => notification`}
						rows={6}
						className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
					/>
					{ruleErrors.length > 0 && (
						<ul className="mt-2 space-y-0.5 text-xs text-kumo-destructive">
							{ruleErrors.map((e) => (
								<li key={e}>{e}</li>
							))}
						</ul>
					)}
				</div>

				{/* Agent System Prompt */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
							<span className="text-sm font-medium text-kumo-default">
								AI Agent Prompt
							</span>
							{isCustomPrompt ? (
								<Badge variant="primary">Custom</Badge>
							) : (
								<Badge variant="secondary">Default</Badge>
							)}
						</div>
						{isCustomPrompt && (
							<Button
								variant="ghost"
								size="xs"
								icon={<ArrowCounterClockwiseIcon size={14} />}
								onClick={handleResetPrompt}
							>
								Reset to default
							</Button>
						)}
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						Customize how the AI agent behaves for this mailbox.
						Leave empty to use the built-in default prompt.
					</p>
					<textarea
						value={agentPrompt}
						onChange={(e) => setAgentPrompt(e.target.value)}
						placeholder={PROMPT_PLACEHOLDER}
						rows={12}
						className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
					/>
					<p className="text-xs text-kumo-subtle mt-2">
						The prompt is sent as the system message to the AI model.
						It controls the agent's personality, writing style, and behavior rules.
					</p>
				</div>

				{/* Save */}
				<div className="flex justify-end">
					<Button variant="primary" onClick={handleSave} loading={isSaving} disabled={ruleErrors.length > 0}>
						Save Changes
					</Button>
				</div>
			</div>
		</div>
	);
}
