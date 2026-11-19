import { Tooltip } from "@cloudflare/kumo";
import { TRIAGE_LABELS, type TriageCategory } from "shared/triage";

const TONE: Partial<Record<TriageCategory, string>> = {
	needs_reply: "text-kumo-brand bg-kumo-tint",
	admin: "text-kumo-default bg-kumo-fill",
	spam: "text-kumo-destructive bg-kumo-fill",
};

export default function TriageBadge({
	category,
	summary,
	actionRequired,
}: {
	category?: string | null;
	summary?: string | null;
	actionRequired?: boolean | number | null;
}) {
	if (!category || !(category in TRIAGE_LABELS)) return null;
	const cat = category as TriageCategory;
	const urgent = !!actionRequired;
	const label = urgent ? `${TRIAGE_LABELS[cat]} · action` : TRIAGE_LABELS[cat];
	const tone = urgent ? "text-kumo-warning bg-kumo-fill" : TONE[cat] ?? "text-kumo-subtle bg-kumo-fill";
	const badge = (
		<span className={`shrink-0 text-xs rounded-full px-1.5 py-0.5 font-medium ${tone}`}>{label}</span>
	);
	return summary ? (
		<Tooltip content={summary} asChild>
			{badge}
		</Tooltip>
	) : (
		badge
	);
}
