import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchBeads,
  fetchBead,
  fetchReadyBeads,
  fetchBeadDeps,
  updateBeadStatus,
} from "../api";

export function useBeads() {
  return useQuery({
    queryKey: ["beads"],
    queryFn: fetchBeads,
    refetchInterval: 5000,
  });
}

export function useBead(id: string) {
  return useQuery({
    queryKey: ["bead", id],
    queryFn: () => fetchBead(id),
    enabled: !!id,
  });
}

export function useReadyBeads() {
  return useQuery({
    queryKey: ["beads", "ready"],
    queryFn: fetchReadyBeads,
    refetchInterval: 5000,
  });
}

export function useBeadDeps(id: string) {
  return useQuery({
    queryKey: ["bead", id, "deps"],
    queryFn: () => fetchBeadDeps(id),
    enabled: !!id,
  });
}

export function useUpdateBeadStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      updateBeadStatus(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["beads"] });
      queryClient.invalidateQueries({ queryKey: ["bead"] });
    },
  });
}
