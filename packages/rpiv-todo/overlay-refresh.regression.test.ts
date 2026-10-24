import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, expect, it, vi } from "vitest";
import registerTodo from "./index.ts";
import { getRenderState } from "./state/store.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

async function setup() {
	let displayedStatus: string | undefined;
	let failRefresh = false;
	const update = vi.fn(() => {
		if (failRefresh) {
			failRefresh = false;
			throw new Error("temporary widget failure");
		}
		displayedStatus = getRenderState().tasks[0]?.status;
	});
	const overlayModule = {
		TodoOverlay: class {
			setUICtx(): void {}
			resetCompletedDisplayState(): void {}
			update = update;
			dispose(): void {}
		},
	} as unknown as typeof import("./todo-overlay.ts");
	const { pi, captured } = createMockPi();
	registerTodo(pi, async () => overlayModule);
	const ctx = createMockCtx({ hasUI: true, sessionId: "foreground" });
	const emit = async (name: string, context = ctx) => {
		for (const handler of captured.events.get(name) ?? []) {
			await handler({ toolName: "todo", isError: false } as never, context as never);
		}
	};
	const mutate = async (params: Record<string, unknown>) => {
		await captured.tools
			.get("todo")
			?.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);
		await emit("tool_execution_end");
	};
	await emit("session_start");
	await mutate({ action: "create", subject: "Finish work" });
	await mutate({ action: "update", id: 1, status: "in_progress" });
	vi.spyOn(console, "warn").mockImplementation(() => {});
	return {
		emit,
		mutate,
		update,
		status: () => displayedStatus,
		failNextRefresh: () => {
			failRefresh = true;
		},
	};
}

it.each(["turn_end", "agent_settled"])(
	"recovers the final completed refresh at %s without another todo call",
	async (boundary) => {
		const lifecycle = await setup();
		lifecycle.failNextRefresh();
		await lifecycle.mutate({ action: "update", id: 1, status: "completed" });
		expect(getRenderState().tasks[0].status).toBe("completed");
		expect(lifecycle.status()).toBe("in_progress");
		await lifecycle.emit(boundary);
		expect(lifecycle.status()).toBe("completed");
		const calls = lifecycle.update.mock.calls.length;
		await lifecycle.emit(boundary);
		expect(lifecycle.update).toHaveBeenCalledTimes(calls);
	},
);

it("does not let a child boundary retry the foreground widget", async () => {
	const lifecycle = await setup();
	lifecycle.failNextRefresh();
	await lifecycle.mutate({ action: "update", id: 1, status: "completed" });
	await lifecycle.emit("turn_end", createMockCtx({ hasUI: false, sessionId: "child" }));
	expect(lifecycle.status()).toBe("in_progress");
	await lifecycle.emit("agent_settled");
	expect(lifecycle.status()).toBe("completed");
});

it("retries only once per boundary and can recover at settlement after a failed turn retry", async () => {
	const lifecycle = await setup();
	lifecycle.failNextRefresh();
	await lifecycle.mutate({ action: "update", id: 1, status: "completed" });
	const calls = lifecycle.update.mock.calls.length;
	lifecycle.failNextRefresh();
	await lifecycle.emit("turn_end");
	expect(lifecycle.update).toHaveBeenCalledTimes(calls + 1);
	expect(lifecycle.status()).toBe("in_progress");
	await lifecycle.emit("agent_settled");
	expect(lifecycle.update).toHaveBeenCalledTimes(calls + 2);
	expect(lifecycle.status()).toBe("completed");
});

it("clears the retry when a subsequent tool event already refreshed the widget", async () => {
	const lifecycle = await setup();
	lifecycle.failNextRefresh();
	await lifecycle.mutate({ action: "update", id: 1, status: "completed" });
	await lifecycle.mutate({ action: "list" });
	expect(lifecycle.status()).toBe("completed");
	const calls = lifecycle.update.mock.calls.length;
	await lifecycle.emit("turn_end");
	await lifecycle.emit("agent_settled");
	expect(lifecycle.update).toHaveBeenCalledTimes(calls);
});

it("discards a pending refresh when the foreground session shuts down", async () => {
	const lifecycle = await setup();
	lifecycle.failNextRefresh();
	await lifecycle.mutate({ action: "update", id: 1, status: "completed" });
	await lifecycle.emit("session_shutdown");
	const calls = lifecycle.update.mock.calls.length;
	await lifecycle.emit("agent_settled");
	expect(lifecycle.update).toHaveBeenCalledTimes(calls);
});
