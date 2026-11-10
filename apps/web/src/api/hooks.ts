import { useQuery } from "@tanstack/react-query";
import { bootstrapQuery, sessionQuery } from "./queries.ts";

export function useSession() {
  return useQuery(sessionQuery);
}

export function useBootstrapData(enabled = true) {
  return useQuery({ ...bootstrapQuery, enabled });
}
