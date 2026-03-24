import { useQuery } from "@tanstack/react-query";
import type { OrchestratorState, AgentMailMessage } from "../api";
import { fetchState } from "../api";

export function useAgentMailInbox() {
  return useQuery({
    queryKey: ["agent-mail-inbox"],
    queryFn: async (): Promise<AgentMailMessage[]> => {
      const state = await fetchState();
      return state.agentMail ?? [];
    },
    refetchInterval: 5000,
  });
}

export function useAgentMailThreads() {
  const { data: messages, ...rest } = useAgentMailInbox();

  const threads = (messages ?? []).reduce<Record<string, AgentMailMessage[]>>(
    (acc, msg) => {
      const key = msg.threadId || "general";
      if (!acc[key]) acc[key] = [];
      acc[key].push(msg);
      return acc;
    },
    {},
  );

  return { threads, messages, ...rest };
}
