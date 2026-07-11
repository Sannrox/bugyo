import { Boxes, Plug, Server, Wrench } from "lucide-react";
import { useFleet } from "./lib/fleetStore";

export default function Plugins() {
  const sessionMap = useFleet((state) => state.sessions);
  const sessions = Object.values(sessionMap);
  const tools = new Set<string>();
  const servers = new Set<string>();
  const agents = new Set<string>();

  for (const session of sessions) {
    for (const tool of session.state.capabilities.tools) tools.add(tool.name);
    for (const server of session.state.capabilities.mcpServers)
      servers.add(server.name);
    for (const agent of session.state.capabilities.subagents)
      agents.add(agent.name);
  }

  const groups = [
    { icon: Wrench, label: "Tools", values: [...tools] },
    { icon: Server, label: "MCP servers", values: [...servers] },
    { icon: Boxes, label: "Agents", values: [...agents] },
  ];

  return (
    <section className="codex-page" aria-labelledby="plugins-title">
      <header className="codex-page__header">
        <div>
          <h1 id="plugins-title">Plugins</h1>
          <p>Capabilities reported by your connected kiro sessions.</p>
        </div>
        <Plug size={20} aria-hidden />
      </header>
      <div className="plugin-grid">
        {groups.map(({ icon: Icon, label, values }) => (
          <section className="plugin-card" key={label}>
            <Icon size={18} aria-hidden />
            <h2>{label}</h2>
            {values.length ? (
              <ul>
                {values.sort().map((value) => (
                  <li key={value}>{value}</li>
                ))}
              </ul>
            ) : (
              <p>No capabilities reported yet.</p>
            )}
          </section>
        ))}
      </div>
    </section>
  );
}
