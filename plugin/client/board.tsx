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
  const [pick, setPick] = useState("");
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
    type Opt = { value: string; label: string };
    const ch = data.choices ?? { providers: [], repos: [] };
    const kindOf = (prov: string) => prov.split("/")[0];
    const modelOf = (prov: string) => prov.split("/").slice(1).join("/");
    const providerOf = (kind: string) => ch.providers.find((p: any) => p.kind === kind) ?? { kind, models: [], modes: [] };
    const profileNames: Opt[] = data.profiles.map((p: any) => ({ value: p.name, label: p.name }));
    const onOff: Opt[] = [{ value: "true", label: "开" }, { value: "false", label: "关" }];
    const inherit: Opt = { value: "default", label: "跟随上级" };
    const withCurrent = (opts: Opt[], cur: string) => (cur && !opts.some((o) => o.value === cur) ? [{ value: cur, label: cur }, ...opts] : opts);
    const input = { color: theme.colors.foreground, borderColor: theme.colors.surface1, borderWidth: 1, borderRadius: 6, padding: 6, fontSize: 13, marginVertical: 6 } as const;
    const chip = (o: Opt, on: boolean, onPress: () => void) => (
      <Pressable key={o.value} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={o.label} disabled={edit.isPending} onPress={onPress}
        style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, marginRight: 6, marginBottom: 6, backgroundColor: on ? theme.colors.accent : theme.colors.surface1, opacity: edit.isPending ? 0.5 : 1 }}>
        <Text style={{ fontSize: 12, color: on ? theme.colors.accentForeground : theme.colors.foreground }}>{o.label}</Text>
      </Pressable>
    );
    const chips = (opts: Opt[], cur: string, onPick: (v: string) => void) => (
      <View style={{ flexDirection: "row", flexWrap: "wrap" as const, marginTop: 6 }}>{opts.map((o) => chip(o, o.value === cur, () => onPick(o.value)))}</View>
    );
    // A row that opens on tap; `body` is what it shows open.
    const row = (k: string, label: string, shown: string, body: () => any, open?: () => void) => (
      <View key={k}>
        <Pressable accessibilityRole="button" accessibilityLabel={`修改 ${label}`} onPress={() => { if (editing === k) setEditing(null); else { setEditing(k); open?.(); } }}>
          <Text style={styles.mono}>{label.padEnd(22)} {shown || "—"}  {editing === k ? "▾" : "▸"}</Text>
        </Pressable>
        {editing === k && <View style={{ marginBottom: 6 }}>{body()}</View>}
      </View>
    );
    // Choosing one option saves it at once.
    const choose = (e: Omit<Edit, "value">, label: string, shown: string, cur: string, opts: Opt[], hint = "") =>
      row(`${e.scope}/${e.target}/${e.key}`, label, shown, () => (<>{hint ? <Text style={styles.meta}>{hint}</Text> : null}{chips(withCurrent(opts, cur), cur, (v) => edit.mutate({ ...e, value: v }))}</>));
    // Free text has no options: a name, a goal, a description.
    const text = (e: Omit<Edit, "value">, label: string, cur: string) =>
      row(`${e.scope}/${e.target}/${e.key}`, label, cur, () => (
        <>
          <TextInput style={input} value={draft} onChangeText={setDraft} autoFocus multiline={e.key === "goal"} accessibilityLabel={label} />
          <View style={{ flexDirection: "row" }}>
            <Btn label="保存" primary theme={theme} disabled={edit.isPending} onPress={() => edit.mutate({ ...e, value: draft.trim() })} />
            <Btn label="取消" theme={theme} onPress={() => setEditing(null)} />
          </View>
        </>
      ), () => setDraft(cur));
    // Several profile names; saved with one button. Empty means any profile.
    const many = (e: Omit<Edit, "value">, label: string, shown: string, cur: string[]) => {
      const set = draft.split(" ").filter(Boolean);
      return row(`${e.scope}/${e.target}/${e.key}`, label, shown, () => (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap" as const, marginTop: 6 }}>
            {profileNames.map((o) => chip(o, set.includes(o.value), () => setDraft((set.includes(o.value) ? set.filter((x) => x !== o.value) : [...set, o.value]).join(" "))))}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap" as const }}>
            <Btn label={set.length ? `只允许这 ${set.length} 个` : "任意 profile"} primary theme={theme} disabled={edit.isPending} onPress={() => edit.mutate({ ...e, value: set.join(" ") })} />
            <Btn label="跟随上级" theme={theme} disabled={edit.isPending} onPress={() => edit.mutate({ ...e, value: "default" })} />
          </View>
        </>
      ), () => setDraft(cur.join(" ")));
    };
    // Provider in two steps: the kind, then its model ("默认模型": the kind alone).
    const providerPicker = (cur: string, onPick: (prov: string) => void) => {
      const kind = pick || kindOf(cur);
      const models: Opt[] = [{ value: "", label: "默认模型" }, ...providerOf(kind).models.map((m: any) => ({ value: m.id, label: m.label }))];
      return (
        <>
          <Text style={styles.meta}>provider</Text>
          {chips(withCurrent(ch.providers.map((p: any) => ({ value: p.kind, label: p.kind })), kindOf(cur)), kind, setPick)}
          <Text style={styles.meta}>模型</Text>
          {chips(kind === kindOf(cur) ? withCurrent(models, modelOf(cur)) : models, kind === kindOf(cur) ? modelOf(cur) : "\u0000", (m) => onPick(m ? `${kind}/${m}` : kind))}
        </>
      );
    };
    const safetyText = (v: unknown) => (typeof v === "boolean" ? (v ? "开" : "关") : Array.isArray(v) ? v.join(" ") || "任意" : v == null ? "任意" : String(v));
    const SAFETY_OPTS: Record<string, Opt[]> = {
      yolo: [{ value: "on", label: "开" }, { value: "off", label: "关" }, inherit],
      routine_commands: [{ value: "on", label: "开" }, { value: "off", label: "关" }, inherit],
      start_threads: [{ value: "propose", label: "先提议" }, { value: "auto", label: "直接开" }, inherit],
    };
    const safetyCur = (v: unknown) => (typeof v === "boolean" ? (v ? "on" : "off") : String(v ?? ""));
    const num = (ns: number[], zero = "") => ns.map((n) => ({ value: String(n), label: n === 0 && zero ? zero : String(n) }));
    const projectOpts = (k: string): Opt[] | null =>
      k.endsWith("_profile") ? profileNames
      : k === "max_parallel_threads" ? num([1, 2, 3, 4, 5, 6, 8, 10])
      : k === "auto_resolve_days" ? num([0, 1, 2, 3, 5, 7, 14, 30], "不自动")
      : k === "nudge" || k === "mute" || k === "pr_checks" ? onOff : null;
    return (
      <View>
        <Text style={styles.meta}>点一行展开，点选项就保存。项目设置直接生效；安全设置和 profile 只能由你改，保存时会弹出 macOS 对话框，点 Allow 才生效。</Text>
        <Text style={[styles.groupTitle, { marginTop: 12 }]}>新项目的默认 profile</Text>
        <View style={styles.card}>
          {(["thread", "coordinator"] as const).map((r) => {
            const cur = data.defaults[`${r}_profile`] ?? "";
            return choose({ scope: "default", target: r, key: "profile" }, `${r}_profile`, cur || "claude", cur, profileNames);
          })}
        </View>
        <Text style={[styles.groupTitle, { marginTop: 8 }]}>Profiles</Text>
        {data.profiles.map((p: any) => {
          const e = (key: string) => ({ scope: "profile" as const, target: p.name, key });
          const model = providerOf(kindOf(p.provider)).models.find((m: any) => m.id === modelOf(p.provider));
          const thinking: Opt[] = [{ value: "", label: "默认" }, ...(model?.thinking ?? []).map((t: any) => ({ value: t.id, label: t.label }))];
          const modes: Opt[] = [{ value: "", label: "默认" }, ...providerOf(kindOf(p.provider)).modes.map((m: any) => ({ value: m.id, label: m.label }))];
          return (
            <View key={p.name} style={styles.card}>
              <Text style={styles.title}>{p.name}{p.builtin ? "（内置）" : ""}</Text>
              {p.builtin ? <Text style={styles.meta}>{p.summary}</Text> : (
                <>
                  {row(`profile/${p.name}/provider`, "provider", p.provider, () => providerPicker(p.provider, (v) => edit.mutate({ ...e("provider"), value: v })), () => setPick(""))}
                  {choose(e("thinking"), "thinking", p.thinking || "默认", p.thinking, thinking)}
                  {choose(e("mode"), "mode", p.mode || "默认", p.mode, modes)}
                  {choose(e("yolo_mode"), "yolo_mode", p.yolo_mode || "默认", p.yolo_mode, modes, "yolo 开启时用的 mode")}
                  {text(e("description"), "description", p.description)}
                  <View style={{ flexDirection: "row", marginTop: 6 }}>
                    <Btn label="删除" theme={theme} disabled={edit.isPending} onPress={() => edit.mutate({ ...e("remove"), value: "" })} />
                  </View>
                </>
              )}
            </View>
          );
        })}
        <View style={styles.card}>
          {row("profile/_new/add", "新建 profile", "", () => (
            <>
              <TextInput style={input} value={draft} onChangeText={setDraft} placeholder="名字，例如 reviewer" autoFocus accessibilityLabel="新 profile 的名字" />
              {providerPicker("", (prov) => edit.mutate({ scope: "profile", target: draft.trim(), key: "add", value: prov }))}
              <Text style={styles.meta}>选好模型就会创建。</Text>
            </>
          ), () => { setDraft(""); setPick(ch.providers[0]?.kind ?? ""); })}
        </View>
        {data.projects.map((p: any) => {
          const repoPaths = p.settings.repos.map((r: string) => r.replace(/@[^/@]*$/, ""));
          const addable: Opt[] = ch.repos.filter((r: string) => !repoPaths.includes(r)).map((r: string) => ({ value: r, label: r.split("/").pop() || r }));
          return (
            <View key={p.project}>
              <Text style={[styles.groupTitle, { marginTop: 8 }]}>{p.project} · {p.status}</Text>
              <View style={styles.card}>
                {Object.entries(p.settings).filter(([k]) => k !== "repos").map(([k, v]) => {
                  const cur = v == null ? "" : String(v);
                  const e = { scope: "project" as const, target: p.project, key: k };
                  const opts = projectOpts(k);
                  const shown = opts?.find((o) => o.value === cur)?.label ?? cur;
                  return opts ? choose(e, k, shown, cur, opts, data.hints[k]) : text(e, k, cur);
                })}
                <Text style={[styles.meta, { marginTop: 6 }]}>repos</Text>
                {p.settings.repos.map((r: string, i: number) => (
                  <View key={r} style={{ flexDirection: "row", alignItems: "center" }}>
                    <Text style={[styles.mono, { flex: 1 }]}>{r}</Text>
                    <Btn label="移除" theme={theme} disabled={edit.isPending} onPress={() => edit.mutate({ scope: "project", target: p.project, key: "repos.remove", value: repoPaths[i] })} />
                  </View>
                ))}
                {row(`project/${p.project}/repos.add`, "添加 repo", "", () => (addable.length
                  ? chips(addable, "", (v) => edit.mutate({ scope: "project", target: p.project, key: "repos.add", value: v }))
                  : <Text style={styles.meta}>Paseo 里的仓库都已加入。别的仓库先在 Paseo 里打开，或在终端用 pp set … repos.add。</Text>))}
                <Text style={[styles.meta, { marginTop: 6, marginBottom: 4 }]}>安全设置（括号里是来源）</Text>
                {Object.entries(p.safety).map(([k, s]: [string, any]) => {
                  const e = { scope: "safety" as const, target: p.project, key: k };
                  const shown = `${safetyText(s.value)} (${s.source})`;
                  return SAFETY_OPTS[k] ? choose(e, k, shown, s.source === "project" ? safetyCur(s.value) : "", SAFETY_OPTS[k], s.hint) : many(e, k, shown, Array.isArray(s.value) ? s.value : []);
                })}
              </View>
            </View>
          );
        })}
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
