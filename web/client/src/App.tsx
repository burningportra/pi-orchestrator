import React, { useState } from "react";
import { Routes, Route, NavLink, Navigate } from "react-router-dom";
import {
  LayoutDashboard,
  Circle,
  GitFork,
  FileText,
  ShieldCheck,
  Mail,
  Bot,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

import Dashboard from "./pages/Dashboard";
import BeadList from "./pages/BeadList";
import BeadDetail from "./pages/BeadDetail";
import DependencyGraph from "./pages/DependencyGraph";
import PlanEditor from "./pages/PlanEditor";
import GatesPanel from "./pages/GatesPanel";
import AgentMailPanel from "./pages/AgentMailPanel";
import SophiaPanel from "./pages/SophiaPanel";

interface NavItem {
  to: string;
  icon: React.ElementType;
  label: string;
}

const navItems: NavItem[] = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/beads", icon: Circle, label: "Beads" },
  { to: "/graph", icon: GitFork, label: "Graph" },
  { to: "/plan", icon: FileText, label: "Plan" },
  { to: "/gates", icon: ShieldCheck, label: "Gates" },
  { to: "/messages", icon: Mail, label: "Messages" },
  { to: "/sophia", icon: Bot, label: "Sophia" },
];

export default function App() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside
        className={`flex flex-col bg-surface-1 border-r border-surface-3 transition-all duration-200 ${
          collapsed ? "w-16" : "w-52"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between h-14 px-3 border-b border-surface-3">
          {!collapsed && (
            <span className="text-sm font-semibold text-accent truncate">
              pi-orchestrator
            </span>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-1.5 rounded hover:bg-surface-2 text-gray-400 hover:text-gray-200 transition-colors"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        {/* Nav links */}
        <nav className="flex-1 py-2 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 mx-1.5 rounded-md text-sm transition-colors ${
                  isActive
                    ? "bg-accent/15 text-accent"
                    : "text-gray-400 hover:bg-surface-2 hover:text-gray-200"
                }`
              }
            >
              <item.icon size={18} className="shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/beads" element={<BeadList />} />
          <Route path="/beads/:id" element={<BeadDetail />} />
          <Route path="/graph" element={<DependencyGraph />} />
          <Route path="/plan" element={<PlanEditor />} />
          <Route path="/gates" element={<GatesPanel />} />
          <Route path="/messages" element={<AgentMailPanel />} />
          <Route path="/sophia" element={<SophiaPanel />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
