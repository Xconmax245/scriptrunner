"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

interface UseRealtimeSyncOptions {
  orgId?: string;
  pollingIntervalMs?: number;
  onUpdate?: () => void;
}

export function useRealtimeSync({
  orgId,
  pollingIntervalMs = 12000,
  onUpdate,
}: UseRealtimeSyncOptions = {}) {
  const router = useRouter();
  const [isRealtimeConnected, setIsRealtimeConnected] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date>(new Date());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  const refreshData = useCallback(async () => {
    setIsRefreshing(true);
    try {
      router.refresh();
      if (onUpdateRef.current) {
        onUpdateRef.current();
      }
      setLastRefreshedAt(new Date());
    } finally {
      setTimeout(() => setIsRefreshing(false), 400);
    }
  }, [router]);

  useEffect(() => {
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;

    if (orgId) {
      // Subscribe to real-time events scoped to this organization
      channel = supabase
        .channel(`org-sync-${orgId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "jobs",
            filter: `organization_id=eq.${orgId}`,
          },
          () => {
            refreshData();
          }
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "devices",
            filter: `organization_id=eq.${orgId}`,
          },
          () => {
            refreshData();
          }
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            setIsRealtimeConnected(true);
          } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
            setIsRealtimeConnected(false);
          }
        });
    }

    // Polling fallback to guarantee consistency even if Realtime drops or misses
    const pollInterval = setInterval(() => {
      refreshData();
    }, pollingIntervalMs);

    return () => {
      clearInterval(pollInterval);
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [orgId, pollingIntervalMs, refreshData]);

  return {
    isRealtimeConnected,
    isRefreshing,
    lastRefreshedAt,
    manualRefresh: refreshData,
  };
}
