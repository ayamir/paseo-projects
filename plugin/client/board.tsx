import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { openExternal } from "./web";
import { boardActionRpc, boardSectionRpc, inboxDoneRpc, inboxListRpc, tasksRpc, threadActionRpc, threadDetailRpc } from "../shared/tasks";

// The thread groups of `pp`, most urgent first.
const GROUPS = [
  { key: "waiting-on-you", label: "等你处理", color: "#dc2626" },
  { key: "ready-for-review", label: "待评审", color: "#8b5cf6" },
  { key: "landing", label: "待合并", color: "#16a34a" },
  { key: "working", label: "进行中", color: "#3b82f6" },
  { key: "idle", label: "空闲", color: "#94a3b8" },
  { key: "resolved", label: "已解决", color: "#64748b" },
];

// The tabs, in HP's popup order.
const TABS = [
  { key: "threads", label: "线程" }, { key: "tasks", label: "任务" }, { key: "inbox", label: "Inbox" },
  { key: "routines", label: "Routines" }, { key: "settings", label: "设置" }, { key: "memory", label: "记忆" },
] as const;
type Tab = (typeof TABS)[number]["key"];
type Section = "tasks" | "routines" | "settings" | "memory";

type Thread = { project: string; id: string; title: string; group: string; profile: string; branch: string | null; pr: string | null; prState: string | null };
type Item = { project: string; id: string; kind: string; subject: string; summary: string };

/** A board button; busy and error text replace the toast HP shows in its footer. */
function Btn({ label, onPress, theme, primary, disabled }: { label: string; onPress: () => void; theme: PluginScreenProps["theme"]; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: primary ? theme.colors.accent : theme.colors.surface1, opacity: disabled ? 0.5 : 0.95, marginRight: 8, marginBottom: 8 }}
    >
      <Text style={{ color: primary ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

export function BoardScreen({ theme, layout }: PluginScreenProps) {
  const client = useQueryClient();
  const listThreads = useRpc(tasksRpc);
  const detailRpc = useRpc(threadDetailRpc);
  const actionRpc = useRpc(threadActionRpc);
  const inboxList = useRpc(inboxListRpc);
  const inboxDoneCall = useRpc(inboxDoneRpc);
  const [tab, setTab] = useState<Tab>("threads");
  const [open, setOpen] = useState<string | null>(null); // `project/id`

  const q = useQuery({ queryKey: ["pp-tasks"], queryFn: () => listThreads({}), refetchInterval: 5000 });
  const inboxQ = useQuery({ queryKey: ["pp-inbox"], queryFn: () => inboxList({}), refetchInterval: 5000 });
  const threads = q.data?.threads ?? [];
  const key = (t: Thread) => `${t.project}/${t.id}`;
  const selected = threads.find((t) => key(t) === open) ?? null;
  const detail = useQuery({ queryKey: ["pp-detail", open], queryFn: () => detailRpc({ project: open!.split("/")[0], id: open!.split("/")[1] }), enabled: Boolean(open) });
  const needsYou = threads.filter((t) => t.group === "waiting-on-you").length;

  const action = useMutation({
    mutationFn: (v: { project: string; id: string; action: "ack" | "restart" | "resolve" | "next"; line?: number }) => actionRpc(v),
    onSuccess: async (r) => { await client.invalidateQueries(); return r; },
  });
  const markDone = useMutation({
    mutationFn: (v: { project: string; ids: string[] }) => inboxDoneCall(v),
    onSuccess: () => client.invalidateQueries(),
  });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 } as const,
      scroll: { padding: layout.compact ? 12 : 20, gap: 16 } as const,
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, marginBottom: 12 },
      tab: { fontSize: 15, fontWeight: "600" as const, color: theme.colors.foreground, opacity: 0.45, marginRight: 16 },
      tabOn: { opacity: 1 },
      groupTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const, marginBottom: 6, opacity: 0.7 } as const,
      card: { backgroundColor: theme.colors.surface1, borderRadius: 10, padding: 12, marginBottom: 8, borderLeftWidth: 3 } as const,
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const } as const,
      meta: { color: theme.colors.foreground, fontSize: 12, opacity: 0.6, marginTop: 4 } as const,
      mono: { color: theme.colors.foreground, fontSize: 11, fontFamily: "Menlo" as const, lineHeight: 16 } as const,
      empty: { color: theme.colors.foreground, opacity: 0.5, textAlign: "center" as const, paddingTop: 60 } as const,
      note: { color: theme.colors.accent, fontSize: 12, marginBottom: 8 } as const,
    }),
    [theme, layout.compact],
  );

  if (q.isLoading) return <View style={styles.screen}><Text style={styles.empty}>加载中…</Text></View>;

  const run = (a: "ack" | "restart" | "resolve", t: Thread) => action.mutate({ project: t.project, id: t.id, action: a });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.scroll}>
      <View style={[styles.row, { flexWrap: "wrap" as const }]}>
        {TABS.map((t) => {
          const count = t.key === "threads" ? `（${threads.filter((x) => x.group !== "resolved").length}）` : t.key === "inbox" ? `（${inboxQ.data?.items.length ?? 0}）` : "";
          return <Pressable key={t.key} accessibilityRole="tab" onPress={() => { setTab(t.key); setOpen(null); }}><Text style={[styles.tab, tab === t.key && styles.tabOn]}>{t.label}{count}</Text></Pressable>;
        })}
      </View>
      {action.isError && <Text style={styles.note}>{String((action.error as Error).message).slice(0, 200)}</Text>}
      {action.isSuccess && !action.isIdle && action.data && <Text style={styles.note}>{action.data.message.slice(0, 120)}</Text>}

      {tab !== "threads" && tab !== "inbox" ? (
        <SectionView section={tab} theme={theme} styles={styles} />
      ) : tab === "inbox" ? (
        <View>
          {(inboxQ.data?.items ?? []).length === 0 && <Text style={styles.empty}>Inbox 是空的。</Text>}
          {(inboxQ.data?.items ?? []).map((i: Item) => (
            <View key={i.id} style={styles.card}>
              <Text style={styles.title}>{i.summary}</Text>
              <Text style={styles.meta}>{i.project} · [{i.kind}] {i.subject}</Text>
              <View style={{ flexDirection: "row", marginTop: 8 }}>
                <Btn label="已处理" disabled={markDone.isPending} theme={theme} onPress={() => markDone.mutate({ project: i.project, ids: [i.id] })} />
              </View>
            </View>
          ))}
        </View>
      ) : !selected ? (
        <View>
          {threads.length === 0 && <Text style={styles.empty}>没有线程。{"\n"}pp open &lt;slug&gt; 启动项目的 coordinator，由它开线程。</Text>}
          {GROUPS.map((g) => {
            const items = threads.filter((t) => t.group === g.key);
            if (items.length === 0) return null;
            return (
              <View key={g.key}>
                <Text style={styles.groupTitle}>{g.label}（{items.length}）</Text>
                {items.map((t: Thread) => (
                  <Pressable key={key(t)} onPress={() => setOpen(key(t))} style={[styles.card, { borderLeftColor: g.color }]}>
                    <Text style={styles.title}>{t.title}</Text>
                    <Text style={styles.meta}>
                      {t.project} · {t.id} · {t.profile}
                      {t.branch ? ` · ${t.branch}` : ""}
                      {t.pr ? ` · PR ${t.prState ?? ""}` : ""}
                    </Text>
                  </Pressable>
                ))}
              </View>
            );
          })}
        </View>
      ) : (
        <View>
          <View style={styles.row}>
            <Pressable accessibilityRole="button" onPress={() => setOpen(null)}><Text style={[styles.tab, styles.tabOn]}>‹ 返回</Text></Pressable>
            <Text style={[styles.tab, { opacity: 0.7 }]}>{needsYou > 0 ? `${needsYou} 个线程等你处理` : ""}</Text>
          </View>
          <Text style={styles.title}>{selected.title}</Text>
          <Text style={styles.meta}>{selected.project} · {selected.id} · {selected.profile}{selected.branch ? ` · ${selected.branch}` : ""}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap" as const, marginTop: 10 }}>
            <Btn label="Ack 报告" theme={theme} disabled={action.isPending} onPress={() => run("ack", selected)} />
            <Btn label="重启" theme={theme} disabled={action.isPending} onPress={() => run("restart", selected)} />
            <Btn label="Resolve" theme={theme} primary disabled={action.isPending} onPress={() => run("resolve", selected)} />
            {selected.pr ? <Btn label="打开 PR" theme={theme} onPress={() => openExternal(selected.pr!)} /> : null}
          </View>
          {(detail.data?.next ?? []).length > 0 && (
            <View style={{ marginTop: 8 }}>
              <Text style={styles.groupTitle}>Next（点击转发给线程）</Text>
              {(detail.data?.next ?? []).map((line, n) => (
                <Pressable key={n} style={styles.card} disabled={action.isPending} onPress={() => action.mutate({ project: selected.project, id: selected.id, action: "next", line: n + 1 })}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{n + 1}. {line}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <Text style={[styles.groupTitle, { marginTop: 12 }]}>报告</Text>
          <Text style={styles.mono}>{detail.data?.report?.slice(0, 8000) ?? "…"}</Text>
        </View>
      )}
    </ScrollView>
  );
}

/** The tasks, routines, settings and memory tabs; a tapped row shows its notes, prompt or text. */
function SectionView({ section, theme, styles }: { section: Section; theme: PluginScreenProps["theme"]; styles: any }) {
  const client = useQueryClient();
  const load = useRpc(boardSectionRpc);
  const act = useRpc(boardActionRpc);
  const q = useQuery({ queryKey: ["pp-board", section], queryFn: () => load({ section }), refetchInterval: 10000 });
  const [shown, setShown] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (v: { project: string; kind: "task" | "routine"; action: "delegate" | "done" | "drop" | "toggle"; target: string }) => act(v),
    onSuccess: () => client.invalidateQueries({ queryKey: ["pp-board", section] }),
  });
  const data = q.data?.data;
  if (q.isError) return <Text style={styles.note}>{String((q.error as Error).message).slice(0, 200)}</Text>;
  if (!data) return <Text style={styles.empty}>加载中…</Text>;
  const text = { color: theme.colors.foreground, fontSize: 13 } as const;
  const toggle = (k: string) => setShown(shown === k ? null : k);
  const status = (
    <>
      {run.isError && <Text style={styles.note}>{String((run.error as Error).message).slice(0, 200)}</Text>}
      {run.isSuccess && <Text style={styles.note}>{run.data.message.slice(0, 120) || "已发送"}</Text>}
    </>
  );

  if (section === "tasks") {
    if (!data.length) return <Text style={styles.empty}>没有任务。让 coordinator 加一条。</Text>;
    let last = "";
    return (
      <View>
        {status}
        {data.map((t: any, i: number) => {
          const head = `${t.project} · ${t.list}`;
          const k = `${t.project}/${t.title}`;
          const header = head !== last ? <Text style={[styles.groupTitle, { marginTop: i ? 8 : 0 }]}>{(last = head)}</Text> : null;
          return (
            <View key={`${k}-${i}`}>
              {header}
              <Pressable style={styles.card} onPress={() => toggle(k)}>
                <Text style={styles.title}>{t.title}{t.notes ? "  ≡" : ""}</Text>
                <Text style={styles.meta}>{[t.owner, t.thread].filter(Boolean).join(" · ") || "未指派"}</Text>
                {shown === k && t.notes ? <Text style={[styles.mono, { marginTop: 8 }]}>{t.notes}</Text> : null}
                {shown === k && (
                  <View style={{ flexDirection: "row", flexWrap: "wrap" as const, marginTop: 8 }}>
                    {!t.thread && <Btn label="派工" primary theme={theme} disabled={run.isPending} onPress={() => run.mutate({ project: t.project, kind: "task", action: "delegate", target: t.title })} />}
                    <Btn label="完成" theme={theme} disabled={run.isPending} onPress={() => run.mutate({ project: t.project, kind: "task", action: "done", target: t.title })} />
                    <Btn label="放弃" theme={theme} disabled={run.isPending} onPress={() => run.mutate({ project: t.project, kind: "task", action: "drop", target: t.title })} />
                  </View>
                )}
              </Pressable>
            </View>
          );
        })}
      </View>
    );
  }

  if (section === "routines") {
    if (!data.length) return <Text style={styles.empty}>没有 routine。让 coordinator 加一个。</Text>;
    return (
      <View>
        {status}
        {data.map((r: any) => {
          const k = `${r.project}/${r.name}`;
          return (
            <Pressable key={k} style={[styles.card, { opacity: r.enabled || r.error ? 1 : 0.6 }]} onPress={() => toggle(k)}>
              <Text style={styles.title}>{r.project} · {r.name}</Text>
              {r.error
                ? <Text style={[styles.meta, { color: "#dc2626", opacity: 1 }]}>配置错误：{r.error}</Text>
                : <Text style={styles.meta}>{r.when} · {r.enabled ? "开启" : "关闭"}{r.command ? " · 命令型" : ""}{r.last ? ` · ${r.last}` : ""}</Text>}
              {shown === k && !r.error && (
                <View style={{ marginTop: 8 }}>
                  <Text style={styles.mono}>{r.command ? `$ ${r.command}\n\n` : ""}{r.prompt}</Text>
                  <View style={{ flexDirection: "row", marginTop: 8 }}>
                    <Btn label={r.enabled ? "关闭" : "开启"} theme={theme} disabled={run.isPending} onPress={() => run.mutate({ project: r.project, kind: "routine", action: "toggle", target: r.name })} />
                  </View>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>
    );
  }

  if (section === "settings") {
    const line = (k: string, v: unknown) => <Text key={k} style={styles.mono}>{k.padEnd(22)} {typeof v === "string" ? v : JSON.stringify(v)}</Text>;
    return (
      <View>
        <Text style={styles.meta}>只读。改设置请在终端执行 pp set / pp safety / pp profile（只能由人执行）。</Text>
        <Text style={[styles.groupTitle, { marginTop: 12 }]}>Profiles（默认：线程 {data.defaults.thread_profile ?? "claude"}，coordinator {data.defaults.coordinator_profile ?? "claude"}）</Text>
        <View style={styles.card}>{data.profiles.map((p: any) => <Text key={p.name} style={styles.mono}>{p.name.padEnd(10)} {p.summary}{p.builtin ? " (built-in)" : ""}</Text>)}</View>
        {data.projects.map((p: any) => (
          <View key={p.project}>
            <Text style={[styles.groupTitle, { marginTop: 8 }]}>{p.project} · {p.status}</Text>
            <View style={styles.card}>
              {Object.entries(p.settings).map(([k, v]) => line(k, v))}
              <Text style={[styles.meta, { marginBottom: 4 }]}>安全设置</Text>
              {Object.entries(p.safety).map(([k, v]) => line(k, v))}
            </View>
          </View>
        ))}
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.meta}>只读。要改记忆，跟 coordinator 说。</Text>
      {data.map((m: any) => {
        const k = `${m.project}/${m.file}`;
        return (
          <Pressable key={k} style={[styles.card, { marginTop: 8 }]} onPress={() => toggle(k)}>
            <Text style={styles.title}>{m.project} · {m.file}</Text>
            {shown === k ? <Text style={[styles.mono, { marginTop: 8 }]}>{m.text.slice(0, 20000) || "（空）"}</Text> : <Text style={styles.meta}>{m.text.length} 字符，点开查看</Text>}
          </Pressable>
        );
      })}
    </View>
  );
}
