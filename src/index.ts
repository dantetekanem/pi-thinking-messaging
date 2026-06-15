import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_PHASE = "Working";
const THINKING_PHASE = "Thinking";
const HIDDEN_THINKING_LABEL = "";
const UPDATE_INTERVAL_MS = 1_000;
const APPROX_CHARS_PER_TOKEN = 4;

type Phase = typeof DEFAULT_PHASE | typeof THINKING_PHASE;

interface ActiveRun {
	startedAt: number;
	phase: Phase;
	completedOutputTokens: number;
	currentMessageOutputTokens: number;
}

let activeRun: ActiveRun | undefined;
let updateTimer: ReturnType<typeof setInterval> | undefined;

const formatElapsed = (elapsedMs: number): string => {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
};

const formatCompactTokens = (tokens: number): string => {
	const rounded = Math.max(0, Math.round(tokens));
	if (rounded < 1_000) return `${rounded} tokens`;
	if (rounded < 1_000_000) return `${(rounded / 1_000).toFixed(1)}k tokens`;
	return `${(rounded / 1_000_000).toFixed(1)}m tokens`;
};

const estimateTokensFromText = (text: string): number => Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);

const stringifyLength = (value: unknown): number => {
	if (value === undefined) return 0;
	try {
		return JSON.stringify(value).length;
	} catch {
		return 0;
	}
};

const estimateOutputTokensFromContent = (content: unknown): number => {
	if (!Array.isArray(content)) return 0;

	let chars = 0;
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const part = item as Record<string, unknown>;

		if (part.type === "text" && typeof part.text === "string") {
			chars += part.text.length;
			continue;
		}

		if (part.type === "thinking" && typeof part.thinking === "string") {
			chars += part.thinking.length;
			continue;
		}

		if (part.type === "toolCall") {
			if (typeof part.name === "string") chars += part.name.length;
			if (typeof part.partialJson === "string") chars += part.partialJson.length;
			chars += stringifyLength(part.arguments);
		}
	}

	return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
};

const currentRunOutputTokens = (run: ActiveRun): number =>
	run.completedOutputTokens + run.currentMessageOutputTokens;

const buildWorkingMessage = (run: ActiveRun, now = Date.now()): string =>
	`${run.phase}… (${formatElapsed(now - run.startedAt)} · ↓ ${formatCompactTokens(currentRunOutputTokens(run))})`;

const updateWorkingMessage = (ctx: ExtensionContext, run: ActiveRun): void => {
	ctx.ui.setWorkingMessage(buildWorkingMessage(run));
};

const setPhase = (ctx: ExtensionContext, run: ActiveRun, phase: Phase): void => {
	if (run.phase !== phase) run.phase = phase;
	updateWorkingMessage(ctx, run);
};

const clearUpdateTimer = (): void => {
	if (updateTimer === undefined) return;
	clearInterval(updateTimer);
	updateTimer = undefined;
};

const restoreWorkingDefaults = (ctx: ExtensionContext): void => {
	ctx.ui.setWorkingMessage();
	ctx.ui.setWorkingIndicator();
};

const restoreAllDefaults = (ctx: ExtensionContext): void => {
	restoreWorkingDefaults(ctx);
	ctx.ui.setHiddenThinkingLabel();
};

const stopRun = (ctx: ExtensionContext): void => {
	clearUpdateTimer();
	activeRun = undefined;
	restoreWorkingDefaults(ctx);
};

const startRun = (ctx: ExtensionContext): void => {
	clearUpdateTimer();

	const run: ActiveRun = {
		startedAt: Date.now(),
		phase: DEFAULT_PHASE,
		completedOutputTokens: 0,
		currentMessageOutputTokens: 0,
	};

	activeRun = run;
	ctx.ui.setWorkingIndicator();
	ctx.ui.setHiddenThinkingLabel(HIDDEN_THINKING_LABEL);
	updateWorkingMessage(ctx, run);
	updateTimer = setInterval(() => {
		if (activeRun !== run) return;
		updateWorkingMessage(ctx, run);
	}, UPDATE_INTERVAL_MS);
};

const reconcileCurrentMessageEstimate = (run: ActiveRun, message: unknown): void => {
	if (!message || typeof message !== "object") return;
	const content = (message as { content?: unknown }).content;
	const estimatedTokens = estimateOutputTokensFromContent(content);
	if (estimatedTokens > run.currentMessageOutputTokens) {
		run.currentMessageOutputTokens = estimatedTokens;
	}
};

const addDeltaEstimate = (run: ActiveRun, assistantMessageEvent: { delta?: unknown }): void => {
	if (typeof assistantMessageEvent.delta !== "string") return;
	run.currentMessageOutputTokens += estimateTokensFromText(assistantMessageEvent.delta);
};

const stripThinkingBlocksFromMessage = (message: unknown): void => {
	if (!message || typeof message !== "object") return;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return;

	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const part = item as { type?: unknown; thinking?: unknown };
		if (part.type === "thinking" && typeof part.thinking === "string") {
			part.thinking = "";
		}
	}
};

const phaseFromAssistantEvent = (assistantMessageEvent: { type?: string }): Phase | undefined => {
	if (assistantMessageEvent.type?.startsWith("thinking_")) return THINKING_PHASE;
	if (
		assistantMessageEvent.type?.startsWith("text_") ||
		assistantMessageEvent.type?.startsWith("toolcall_") ||
		assistantMessageEvent.type === "done"
	) {
		return DEFAULT_PHASE;
	}
	return undefined;
};

export default function thinkingMessagingExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		clearUpdateTimer();
		activeRun = undefined;
		ctx.ui.setHiddenThinkingLabel(HIDDEN_THINKING_LABEL);
		restoreWorkingDefaults(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		startRun(ctx);
	});

	pi.on("message_start", (event, ctx) => {
		if (!activeRun || event.message.role !== "assistant") return;
		activeRun.currentMessageOutputTokens = 0;
		stripThinkingBlocksFromMessage(event.message);
		setPhase(ctx, activeRun, DEFAULT_PHASE);
	});

	pi.on("message_update", (event, ctx) => {
		if (!activeRun || event.message.role !== "assistant") return;
		addDeltaEstimate(activeRun, event.assistantMessageEvent);
		reconcileCurrentMessageEstimate(activeRun, event.message);
		stripThinkingBlocksFromMessage(event.message);
		const phase = phaseFromAssistantEvent(event.assistantMessageEvent);
		if (phase) {
			setPhase(ctx, activeRun, phase);
			return;
		}
		updateWorkingMessage(ctx, activeRun);
	});

	pi.on("message_end", (event, ctx) => {
		if (!activeRun || event.message.role !== "assistant") return;

		reconcileCurrentMessageEstimate(activeRun, event.message);
		stripThinkingBlocksFromMessage(event.message);
		const usageOutput = event.message.usage?.output;
		activeRun.completedOutputTokens +=
			typeof usageOutput === "number" && Number.isFinite(usageOutput) && usageOutput > 0
				? usageOutput
				: activeRun.currentMessageOutputTokens;
		activeRun.currentMessageOutputTokens = 0;
		setPhase(ctx, activeRun, DEFAULT_PHASE);
	});

	pi.on("tool_execution_start", (_event, ctx) => {
		if (!activeRun) return;
		setPhase(ctx, activeRun, DEFAULT_PHASE);
	});

	pi.on("agent_end", (_event, ctx) => {
		stopRun(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearUpdateTimer();
		activeRun = undefined;
		restoreAllDefaults(ctx);
	});
}
