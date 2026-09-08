import assert from "node:assert/strict";
import test from "node:test";
import thinkingMessagingExtension, {
	IDLE_NOTICE,
	IDLE_PROBABLY_IDLE_NOTICE,
	IDLE_TAKING_A_WHILE_NOTICE,
} from "../src/index.ts";

function createSession() {
	type API = Parameters<typeof thinkingMessagingExtension>[0];
	type Context = Parameters<Parameters<API["on"]>[1]>[1];
	type Handler = (event: any, ctx: Context) => void;
	const handlers = new Map<Parameters<API["on"]>[0], Handler>();
	let message: string | undefined;
	const ctx = {
		ui: {
			setWorkingMessage: (value?: string) => { message = value; },
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
		},
	};
	thinkingMessagingExtension({ on: (name, handler) => { handlers.set(name, handler); } });
	return {
		emit: (name: Parameters<API["on"]>[0], event: unknown = {}) => handlers.get(name)?.(event, ctx),
		message: () => message ?? "",
	};
}

test("advances all idle stages while a provider request is silent, then recovers on tokens", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
	const session = createSession();
	t.after(() => session.emit("session_shutdown"));
	session.emit("session_start");
	session.emit("agent_start");
	session.emit("before_provider_request", { payload: {} });

	for (const [time, notice] of [
		[61_000, IDLE_TAKING_A_WHILE_NOTICE],
		[181_000, IDLE_PROBABLY_IDLE_NOTICE],
		[301_000, IDLE_NOTICE],
	] as const) {
		t.mock.timers.tick(time - Date.now());
		assert.ok(session.message().includes(notice), session.message());
	}

	session.emit("message_update", {
		message: { role: "assistant", content: [{ type: "thinking", thinking: "hello" }] },
		assistantMessageEvent: { type: "thinking_delta", delta: "hello" },
	});
	assert.match(session.message(), /^Thinking/);
	assert.doesNotMatch(session.message(), /agent is/);
	t.mock.timers.tick(301_000);
	assert.ok(session.message().includes(IDLE_NOTICE));
	session.emit("agent_end");
	t.mock.timers.tick(301_000);
	assert.equal(session.message(), "");
});

test("another session's lifecycle cannot cancel the lead's idle warning", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
	const lead = createSession();
	const child = createSession();
	t.after(() => { lead.emit("session_shutdown"); child.emit("session_shutdown"); });
	lead.emit("session_start");
	lead.emit("agent_start");
	t.mock.timers.tick(30_000);
	child.emit("session_start");
	child.emit("agent_start");
	child.emit("before_provider_request", { payload: {} });
	child.emit("agent_end");
	child.emit("session_shutdown");
	t.mock.timers.tick(271_000);
	assert.ok(lead.message().includes(IDLE_NOTICE), lead.message());
	assert.match(lead.message(), /5m 1s/);
});

test("a busy child does not reset the lead's inactivity clock or token count", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
	const lead = createSession();
	const child = createSession();
	t.after(() => { lead.emit("session_shutdown"); child.emit("session_shutdown"); });
	lead.emit("session_start");
	lead.emit("before_agent_start", { prompt: "lead" });
	child.emit("session_start");
	child.emit("before_agent_start", { prompt: "child prompt" });
	lead.emit("agent_start");
	child.emit("agent_start");
	t.mock.timers.tick(300_000);
	child.emit("before_provider_request", { payload: {} });
	t.mock.timers.tick(1_000);
	assert.ok(lead.message().includes(IDLE_NOTICE), lead.message());
	assert.match(lead.message(), /↑ 1 tokens/);
	assert.doesNotMatch(child.message(), /agent is/);
});
