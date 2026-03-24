import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchPlan, savePlan, fetchPlanAudit } from "../api";

export function usePlan() {
  return useQuery({
    queryKey: ["plan"],
    queryFn: fetchPlan,
  });
}

export function useSavePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => savePlan(content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plan"] });
    },
  });
}

export function usePlanAudit() {
  return useQuery({
    queryKey: ["plan-audit"],
    queryFn: fetchPlanAudit,
    enabled: false, // manually triggered
  });
}
