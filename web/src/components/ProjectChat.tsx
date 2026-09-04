import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createProjectMessage, listProjectAgents, listProjectMessages } from "../api";
import type { ActorIdentity, AgentStatus, Project, ProjectMessage, Task } from "../types";

interface ProjectChatProps {
  project: Project;
  currentUser: ActorIdentity;
  tasks: Task[];
  onOpenTask: (task: Task) => void;
}

function messageTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function mentionedAgents(body: string, agents: AgentStatus[]): string[] {
  const names = new Map<string, string>();
  names.set("agent", "agent");
  names.set("agents", "agent");
  names.set("全部agent", "agent");
  for (const agent of agents) {
    names.set(agent.id.toLowerCase(), agent.id);
    // A product name represents the whole pool (for example every Codex
    // device); an id or Name·Device mention selects one concrete worker.
    names.set(agent.name.toLowerCase(), agent.name);
    if (agent.device) names.set(`${agent.name}·${agent.device}`.toLowerCase(), agent.id);
  }
  const found = new Set<string>();
  for (const match of body.matchAll(/@([\p{L}\p{N}_·\-.]{1,60})/gu)) {
    const token = match[1].trim().toLowerCase();
    if (names.has(token)) found.add(names.get(token) as string);
  }
  return [...found];
}

export function ProjectChat({ project, currentUser, tasks, onOpenTask }: ProjectChatProps) {
  const [messages, setMessages] = useState<ProjectMessage[]>([]);
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const cursorRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const pendingMentions = useMemo(() => mentionedAgents(draft, agents), [draft, agents]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await listProjectMessages(project.id, cursorRef.current, signal);
    if (result.messages.length > 0) {
      setMessages((current) => {
        const known = new Set(current.map((message) => message.id));
        return [...current, ...result.messages.filter((message) => !known.has(message.id))];
      });
      cursorRef.current = result.nextCursor;
    }
  }, [project.id]);

  useEffect(() => {
    const controller = new AbortController();
    cursorRef.current = 0;
    setMessages([]);
    setLoading(true);
    setError("");
    void refresh(controller.signal)
      .catch((cause) => {
        if ((cause as Error).name !== "AbortError") setError((cause as Error).message);
      })
      .finally(() => setLoading(false));
    const timer = window.setInterval(() => {
      void refresh().catch(() => {});
    }, 2_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [project.id, refresh]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length]);

  useEffect(() => {
    const load = (signal?: AbortSignal) => listProjectAgents(project.id, signal)
      .then(setAgents)
      .catch(() => {});
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [project.id]);

  async function sendMessage() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError("");
    try {
      const message = await createProjectMessage(project.id, {
        body,
        mentions: mentionedAgents(body, agents),
      });
      setMessages((current) => current.some((item) => item.id === message.id)
        ? current
        : [...current, message]);
      cursorRef.current = Math.max(cursorRef.current, message.sequence);
      setDraft("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="project-chat" aria-label={`${project.name} 项目群聊`}>
      <header className="project-chat-header">
        <div>
          <h2>项目群聊</h2>
          <p>成员与 Agent 共用一条可审计消息流；输入 @Agent 可发起工作请求。</p>
        </div>
        <span className="project-chat-live"><i aria-hidden="true" />实时同步</span>
      </header>

      <div className="project-chat-agents" aria-label="Agent 在线状态">
        {agents.length === 0 && <small>暂无已注册 Agent</small>}
        {agents.map((agent) => (
          <span key={agent.id} className={`project-chat-agent${agent.online ? " is-online" : ""}`}>
            <i aria-hidden="true" />
            {agent.device ? `${agent.name}·${agent.device}` : agent.name}
            <small>{agent.online ? `在线 · ${agent.activeLeases.length}/${agent.concurrency} 任务` : "离线"}</small>
          </span>
        ))}
      </div>

      <div className="project-chat-messages" aria-live="polite">
        {loading && <p className="project-chat-empty">正在载入项目消息…</p>}
        {!loading && messages.length === 0 && (
          <div className="project-chat-empty">
            <strong>这里是项目的公共协作空间</strong>
            <span>所有项目成员都能看到消息与 Agent 进度。</span>
          </div>
        )}
        {messages.map((message) => {
          const own = message.author.type === currentUser.type && message.author.id === currentUser.id;
          const linkedTask = message.taskId ? taskById.get(message.taskId) : null;
          return (
            <article
              className={`project-chat-message${own ? " is-own" : ""}${message.author.type === "agent" ? " is-agent" : ""}`}
              key={message.id}
            >
              <div className="project-chat-avatar" aria-hidden="true">
                {message.author.avatarUrl
                  ? <img src={message.author.avatarUrl} alt="" />
                  : message.author.type === "agent" ? "AI" : message.author.name.slice(0, 1)}
              </div>
              <div className="project-chat-bubble">
                <div className="project-chat-meta">
                  <strong>{message.author.name}</strong>
                  {message.author.type === "agent" && <span>Agent</span>}
                  {message.kind !== "message" && <span>{message.kind === "progress" ? "进度" : "决策"}</span>}
                  <time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>
                </div>
                <p>{message.body}</p>
                {linkedTask && (
                  <button type="button" className="project-chat-task" onClick={() => onOpenTask(linkedTask)}>
                    {linkedTask.identifier} · {linkedTask.title}
                  </button>
                )}
                {message.mentions.length > 0 && message.author.type === "user" && (
                  <small className="project-chat-requested">
                    已通知：{message.mentions.map((mention) => `@${mention}`).join(" ")}
                  </small>
                )}
              </div>
            </article>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <footer className="project-chat-composer">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void sendMessage();
            }
          }}
          placeholder="发消息；输入 @Agent 安排工作…"
          rows={3}
          maxLength={100_000}
        />
        <div>
          {error && <span role="alert">{error}</span>}
          {pendingMentions.length > 0 && (
            <small className="project-chat-mention-hint">
              将通知：{pendingMentions.map((mention) => `@${mention}`).join(" ")}
            </small>
          )}
          <small>⌘/Ctrl + Enter 发送</small>
          <button type="button" disabled={!draft.trim() || sending} onClick={() => void sendMessage()}>
            {sending ? "发送中…" : "发送"}
          </button>
        </div>
      </footer>
    </section>
  );
}
