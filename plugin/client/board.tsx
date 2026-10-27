import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { openExternal } from "./web";
import { boardActionRpc, boardEditRpc, boardSectionRpc, inboxDoneRpc, inboxListRpc, tasksRpc, threadActionRpc, threadDetailRpc } from "../shared/tasks";

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
  const editRpc = useRpc(boardEditRpc);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const q = useQuery({ queryKey: ["pp-board", section], queryFn: () => load({ section }), refetchInterval: 10000 });
  const [shown, setShown] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (v: { project: string; kind: "task" | "routine"; action: "delegate" | "done" | "drop" | "toggle"; target: string }) => act(v),
    onSuccess: () => client.invalidateQueries({ queryKey: ["pp-board", section] }),
  });
  type Edit = { scope: "project" | "safety" | "profile" | "default"; target: string; key: string; value: string };
  const edit = useMutation({
    mutationFn: (v: Edit) => editRpc(v),
    onSuccess: () => { setEditing(null); client.invalidateQueries({ queryKey: ["pp-board", section] }); },
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
      {edit.isError && <Text style={styles.note}>{String((edit.error as Error).message).slice(0, 200)}</Text>}
      {edit.isSuccess && <Text style={styles.note}>{edit.data.message.slice(0, 160) || "已修改"}</Text>}
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
    const input = { color: theme.colors.foreground, borderColor: theme.colors.surface1, borderWidth: 1, borderRadius: 6, padding: 6, fontSize: 13, marginVertical: 6 } as const;
    // One editable row: tap it, change the text, save. `initial` is what the box starts with.
    const field = (e: Omit<Edit, "value">, label: string, shownValue: string, initial: string, hint = "") => {
      const k = `${e.scope}/${e.target}/${e.key}`;
      return (
        <View key={k}>
          <Pressable accessibilityRole="button" accessibilityLabel={`修改 ${label}`} onPress={() => { setEditing(editing === k ? null : k); setDraft(initial); }}>
            <Text style={styles.mono}>{label.padEnd(22)} {shownValue || "—"}  ✎</Text>
          </Pressable>
          {editing === k && (
            <View>
              {hint ? <Text style={styles.meta}>{hint}</Text> : null}
              <TextInput style={input} value={draft} onChangeText={setDraft} autoFocus multiline={e.key === "goal"} accessibilityLabel={label} />
              <View style={{ flexDirection: "row" }}>
                <Btn label="保存" primary theme={theme} disabled={edit.isPending} onPress={() => { const w = draft.trim().split(/\s+/); edit.mutate(e.key === "add" ? { ...e, target: w[0] ?? "", value: w.slice(1).join(" ") } : { ...e, value: draft.trim() }); }} />
                <Btn label="取消" theme={theme} onPress={() => setEditing(null)} />
              </View>
            </View>
          )}
        </View>
      );
    };
    const safetyText = (v: unknown) => (typeof v === "boolean" ? (v ? "on" : "off") : Array.isArray(v) ? v.join(" ") : v == null ? "" : String(v));
    return (
      <View>
        <Text style={styles.meta}>点一行就能改。项目设置直接生效；安全设置和 profile 只能由你改，保存后会弹出 macOS 对话框，点"Allow"才生效。</Text>
        <Text style={[styles.groupTitle, { marginTop: 12 }]}>新项目的默认 profile</Text>
        <View style={styles.card}>
          {(["thread", "coordinator"] as const).map((r) => field({ scope: "default", target: r, key: "profile" }, `${r}_profile`, data.defaults[`${r}_profile`] ?? "claude", data.defaults[`${r}_profile`] ?? ""))}
        </View>
        <Text style={[styles.groupTitle, { marginTop: 8 }]}>Profiles</Text>
        {data.profiles.map((p: any) => (
          <View key={p.name} style={styles.card}>
            <Text style={styles.title}>{p.name}{p.builtin ? "（内置，不能改）" : ""}</Text>
            {p.builtin ? <Text style={styles.meta}>{p.summary}</Text> : (
              <>
                {["provider", "mode", "thinking", "yolo_mode", "description"].map((f) => field({ scope: "profile", target: p.name, key: f }, f, p[f], p[f], f === "provider" ? "KIND/MODEL，例如 claude/claude-opus-5-5" : "留空表示清除"))}
                <View style={{ flexDirection: "row", marginTop: 6 }}>
                  <Btn label="删除" theme={theme} disabled={edit.isPending} onPress={() => edit.mutate({ scope: "profile", target: p.name, key: "remove", value: "" })} />
                </View>
              </>
            )}
          </View>
        ))}
        <View style={styles.card}>
          {field({ scope: "profile", target: "_new", key: "add" }, "新建 profile", "", "", "名字 和 provider，空格隔开，例如：reviewer claude/claude-opus-5-5")}
        </View>
        {data.projects.map((p: any) => (
          <View key={p.project}>
            <Text style={[styles.groupTitle, { marginTop: 8 }]}>{p.project} · {p.status}</Text>
            <View style={styles.card}>
              {Object.entries(p.settings).filter(([k]) => k !== "repos").map(([k, v]) => field({ scope: "project", target: p.project, key: k }, k, v == null ? "" : String(v), v == null ? "" : String(v), data.hints[k]))}
              <Text style={[styles.meta, { marginTop: 6 }]}>repos</Text>
              {p.settings.repos.map((r: string) => (
                <View key={r} style={{ flexDirection: "row", alignItems: "center" }}>
                  <Text style={[styles.mono, { flex: 1 }]}>{r}</Text>
                  <Btn label="移除" theme={theme} disabled={edit.isPending} onPress={() => edit.mutate({ scope: "project", target: p.project, key: "repos.remove", value: r.replace(/@[^/@]*$/, "") })} />
                </View>
              ))}
              {field({ scope: "project", target: p.project, key: "repos.add" }, "添加 repo", "", "", data.hints["repos.add"])}
              <Text style={[styles.meta, { marginTop: 6, marginBottom: 4 }]}>安全设置（括号里是来源；填 default 表示跟随上一级）</Text>
              {Object.entries(p.safety).map(([k, s]: [string, any]) => field({ scope: "safety", target: p.project, key: k }, k, `${safetyText(s.value) || "any"} (${s.source})`, safetyText(s.value), s.hint))}
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
