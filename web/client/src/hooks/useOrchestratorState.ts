import { useQuery } from "@tanstack/react-query";
import { fetchState, fetchInsights, fetchNext } from "../api";

export function useOrchestratorState() {
  return useQuery({
    queryKey: ["orchestrator-state"],
    queryFn: fetchState,
    refetchInterval: 3000,
  });
}

export function useInsights() {
  return useQuery({
    queryKey: ["bv-insights"],
    queryFn: fetchInsights,
    refetchInterval: 10000,
  });
}

export function useNextPick() {
  return useQuery({
    queryKey: ["bv-next"],
    queryFn: fetchNext,
  });
}
