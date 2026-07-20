export type AgentStatus = "idle" | "working" | "blocked" | "unknown";

export interface AgentInfo {
	paneId: string;
	agent: string;
	status: AgentStatus;
	cwd: string;
	focused: boolean;
	workspaceId: string;
}

export interface HerdrRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

export interface HerdrResponse {
	id?: string;
	result?: unknown;
	error?: { code: string; message: string };
	type?: string;
}
