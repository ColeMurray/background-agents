"use client";

import { useState } from "react";

type Variation = "spotlight" | "command" | "conversation" | "split" | "ambient";

export default function DesignLabPage() {
  const [activeVariation, setActiveVariation] = useState<Variation>("spotlight");

  const variations: { id: Variation; name: string; description: string }[] = [
    {
      id: "spotlight",
      name: "Spotlight",
      description: "Preview as hero - visual verification front and center",
    },
    {
      id: "command",
      name: "Command Center",
      description: "IDE-style panels - power user information density",
    },
    {
      id: "conversation",
      name: "Flow",
      description: "Elegant conversation - minimal, focused, Linear-inspired",
    },
    {
      id: "split",
      name: "Dual Focus",
      description: "Equal chat/preview split - both always visible",
    },
    {
      id: "ambient",
      name: "Ambient",
      description: "Dark immersive - screenshots as art, subtle UI",
    },
  ];

  return (
    <div className="h-screen flex flex-col bg-[#0a0a0a]">
      {/* Variation Selector */}
      <nav className="flex-shrink-0 border-b border-white/10 bg-[#0a0a0a]">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="text-white/40 text-sm font-medium uppercase tracking-wider">
              Design Lab
            </span>
            <span className="text-white/20">|</span>
            <span className="text-white text-sm">Open-Inspect Redesign</span>
          </div>
          <div className="flex gap-1 bg-white/5 p-1 rounded-lg">
            {variations.map((v) => (
              <button
                key={v.id}
                onClick={() => setActiveVariation(v.id)}
                className={`px-4 py-2 text-sm rounded-md transition-all ${
                  activeVariation === v.id
                    ? "bg-white text-black font-medium"
                    : "text-white/60 hover:text-white hover:bg-white/10"
                }`}
              >
                {v.name}
              </button>
            ))}
          </div>
        </div>
        <div className="px-6 pb-4">
          <p className="text-white/40 text-sm">
            {variations.find((v) => v.id === activeVariation)?.description}
          </p>
        </div>
      </nav>

      {/* Variation Content */}
      <main className="flex-1 overflow-hidden">
        {activeVariation === "spotlight" && <SpotlightVariation />}
        {activeVariation === "command" && <CommandCenterVariation />}
        {activeVariation === "conversation" && <FlowVariation />}
        {activeVariation === "split" && <DualFocusVariation />}
        {activeVariation === "ambient" && <AmbientVariation />}
      </main>
    </div>
  );
}

// ============================================================================
// VARIATION 1: SPOTLIGHT
// Preview as the hero - visual verification front and center
// ============================================================================
function SpotlightVariation() {
  return (
    <div className="h-full flex bg-[#fafafa]">
      {/* Compact Left Sidebar - Sessions */}
      <aside className="w-16 bg-white border-r border-black/5 flex flex-col items-center py-4 gap-2">
        <div className="w-9 h-9 rounded-lg bg-black flex items-center justify-center mb-4">
          <span className="text-white font-bold text-sm">O</span>
        </div>
        {[1, 2, 3, 4, 5].map((i) => (
          <button
            key={i}
            className={`w-10 h-10 rounded-lg transition-all ${
              i === 1 ? "bg-black/10 ring-2 ring-black/20" : "hover:bg-black/5"
            }`}
          >
            <span className="text-black/40 text-xs font-medium">{i}</span>
          </button>
        ))}
        <div className="flex-1" />
        <button className="w-10 h-10 rounded-lg hover:bg-black/5 flex items-center justify-center">
          <PlusIcon className="w-5 h-5 text-black/40" />
        </button>
      </aside>

      {/* Chat Column - Compact */}
      <div className="w-[380px] flex flex-col bg-white border-r border-black/5">
        {/* Session Header */}
        <header className="px-5 py-4 border-b border-black/5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-base font-semibold text-black">Fix auth redirect bug</h1>
              <p className="text-sm text-black/40">anthropics/console</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-xs text-emerald-600">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Connected
              </span>
            </div>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <MessageBubble
            role="user"
            content="The OAuth redirect is failing after login. Users are getting stuck on a blank page."
            time="2:34 PM"
          />
          <MessageBubble
            role="assistant"
            content="I've identified the issue. The callback URL wasn't properly URL-encoded. I've pushed a fix and the preview is now showing the correct redirect behavior."
            time="2:35 PM"
          />
          <div className="flex items-center gap-2 py-2">
            <div className="h-px flex-1 bg-black/10" />
            <span className="text-xs text-black/30 font-medium">Screenshot captured</span>
            <div className="h-px flex-1 bg-black/10" />
          </div>
          <MessageBubble
            role="user"
            content="Great, can you also add a loading state while the redirect happens?"
            time="2:36 PM"
          />
          <ThinkingIndicator />
        </div>

        {/* Input */}
        <div className="p-4 border-t border-black/5">
          <div className="relative">
            <textarea
              placeholder="Describe what you want to build..."
              className="w-full px-4 py-3 pr-12 text-sm bg-black/[0.02] border border-black/10 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-black/20 focus:border-transparent"
              rows={2}
            />
            <button className="absolute right-3 bottom-3 p-1.5 bg-black text-white rounded-lg hover:bg-black/80 transition">
              <ArrowUpIcon className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center justify-between mt-3">
            <div className="flex items-center gap-2">
              <ModelBadge model="claude-sonnet" />
              <button className="text-xs text-black/40 hover:text-black transition">
                + Attach
              </button>
            </div>
            <button className="text-xs text-black/40 hover:text-black transition flex items-center gap-1">
              <MicIcon className="w-3.5 h-3.5" />
              Voice
            </button>
          </div>
        </div>
      </div>

      {/* Preview Hero - Takes Most Space */}
      <div className="flex-1 flex flex-col bg-[#f5f5f5]">
        {/* Preview Toolbar */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-white border-b border-black/5">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-black/5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-medium text-black/60">Live Preview</span>
            </div>
            <span className="text-xs text-black/30">localhost:5173/login</span>
          </div>
          <div className="flex items-center gap-2">
            <button className="p-2 hover:bg-black/5 rounded-lg transition">
              <RefreshIcon className="w-4 h-4 text-black/40" />
            </button>
            <button className="p-2 hover:bg-black/5 rounded-lg transition">
              <SelectIcon className="w-4 h-4 text-black/40" />
            </button>
            <button className="p-2 hover:bg-black/5 rounded-lg transition">
              <ExternalLinkIcon className="w-4 h-4 text-black/40" />
            </button>
          </div>
        </div>

        {/* Preview Content */}
        <div className="flex-1 p-6 overflow-hidden">
          <div className="h-full bg-white rounded-xl shadow-2xl shadow-black/10 overflow-hidden border border-black/5">
            {/* Mock App UI */}
            <div className="h-full flex flex-col">
              <div className="h-8 bg-[#f8f8f8] border-b border-black/5 flex items-center px-3 gap-1.5">
                <span className="w-3 h-3 rounded-full bg-red-400" />
                <span className="w-3 h-3 rounded-full bg-yellow-400" />
                <span className="w-3 h-3 rounded-full bg-green-400" />
              </div>
              <div className="flex-1 flex items-center justify-center bg-gradient-to-br from-indigo-50 to-white p-8">
                <div className="w-full max-w-sm">
                  <div className="text-center mb-8">
                    <div className="w-12 h-12 bg-indigo-600 rounded-xl mx-auto mb-4 flex items-center justify-center">
                      <span className="text-white font-bold text-lg">A</span>
                    </div>
                    <h2 className="text-xl font-semibold text-gray-900">Welcome back</h2>
                    <p className="text-sm text-gray-500 mt-1">Sign in to your account</p>
                  </div>
                  <button className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-800 transition">
                    <GitHubIcon className="w-5 h-5" />
                    Continue with GitHub
                  </button>
                  {/* Loading state preview */}
                  <div className="mt-4 flex items-center justify-center gap-2 text-sm text-indigo-600">
                    <span className="w-4 h-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                    Redirecting...
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Screenshot Timeline */}
        <div className="px-6 pb-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-medium text-black/40">Screenshot Timeline</span>
            <span className="text-xs text-black/20">•</span>
            <span className="text-xs text-black/30">12 frames</span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <button
                key={i}
                className={`flex-shrink-0 w-24 h-16 rounded-lg overflow-hidden transition-all ${
                  i === 8 ? "ring-2 ring-black" : "opacity-60 hover:opacity-100"
                }`}
              >
                <div className="w-full h-full bg-gradient-to-br from-indigo-100 to-white flex items-center justify-center">
                  <span className="text-xs text-black/20">{i}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Right Sidebar - Metadata */}
      <aside className="w-64 bg-white border-l border-black/5 p-4 space-y-6">
        <div>
          <h3 className="text-xs font-medium text-black/40 uppercase tracking-wider mb-3">
            Participants
          </h3>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 text-xs font-medium">
              BJ
            </div>
            <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 text-xs font-medium">
              AI
            </div>
          </div>
        </div>
        <div>
          <h3 className="text-xs font-medium text-black/40 uppercase tracking-wider mb-3">
            Branch
          </h3>
          <code className="text-xs text-black/60 bg-black/5 px-2 py-1 rounded">
            fix/auth-redirect
          </code>
        </div>
        <div>
          <h3 className="text-xs font-medium text-black/40 uppercase tracking-wider mb-3">
            Files Changed
          </h3>
          <ul className="space-y-1">
            <li className="text-xs text-black/60 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              src/auth/callback.ts
            </li>
            <li className="text-xs text-black/60 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              src/components/Login.tsx
            </li>
          </ul>
        </div>
        <button className="w-full py-2.5 bg-black text-white text-sm font-medium rounded-lg hover:bg-black/90 transition">
          View Pull Request
        </button>
      </aside>
    </div>
  );
}

// ============================================================================
// VARIATION 2: COMMAND CENTER
// IDE-style panels - power user information density
// ============================================================================
function CommandCenterVariation() {
  return (
    <div className="h-full flex flex-col bg-[#1e1e1e] text-white">
      {/* Top Bar - Linear style */}
      <header className="flex items-center justify-between px-4 py-2 bg-[#252526] border-b border-white/5">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center">
              <span className="text-white font-bold text-xs">O</span>
            </div>
            <span className="text-sm font-medium">Open-Inspect</span>
          </div>
          <div className="h-4 w-px bg-white/10" />
          <nav className="flex items-center gap-1">
            {["Sessions", "Templates", "Settings"].map((item, i) => (
              <button
                key={item}
                className={`px-3 py-1.5 text-sm rounded transition ${
                  i === 0
                    ? "bg-white/10 text-white"
                    : "text-white/50 hover:text-white hover:bg-white/5"
                }`}
              >
                {item}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-white/5 rounded-lg">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-xs text-white/60">Connected</span>
          </div>
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-amber-400 to-orange-500" />
        </div>
      </header>

      {/* Main IDE Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Activity Bar */}
        <div className="w-12 bg-[#252526] flex flex-col items-center py-2 gap-1 border-r border-white/5">
          {[FileIcon, ChatIcon, PreviewIcon, GitIcon, SettingsIcon].map((Icon, i) => (
            <button
              key={i}
              className={`w-10 h-10 rounded-lg flex items-center justify-center transition ${
                i === 1
                  ? "bg-white/10 text-white"
                  : "text-white/40 hover:text-white hover:bg-white/5"
              }`}
            >
              <Icon className="w-5 h-5" />
            </button>
          ))}
        </div>

        {/* Session List Panel */}
        <div className="w-56 bg-[#252526] border-r border-white/5 flex flex-col">
          <div className="px-3 py-2 border-b border-white/5">
            <input
              type="text"
              placeholder="Search sessions..."
              className="w-full px-3 py-1.5 bg-white/5 border border-white/10 rounded text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/20"
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            <div className="px-2 py-2">
              <span className="px-2 text-xs font-medium text-white/30 uppercase tracking-wider">
                Active
              </span>
              <div className="mt-2 space-y-0.5">
                {[
                  { name: "Fix auth redirect", repo: "console", active: true },
                  { name: "Add dark mode", repo: "marketing", active: false },
                  { name: "Refactor API", repo: "backend", active: false },
                ].map((session, i) => (
                  <button
                    key={i}
                    className={`w-full px-2 py-2 rounded text-left transition ${
                      session.active ? "bg-white/10" : "hover:bg-white/5"
                    }`}
                  >
                    <div className="text-sm text-white/90 truncate">{session.name}</div>
                    <div className="text-xs text-white/40 truncate">{session.repo}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Main Content Area - Flexible Panels */}
        <div className="flex-1 flex flex-col">
          {/* Tab Bar */}
          <div className="flex items-center bg-[#252526] border-b border-white/5">
            <div className="flex">
              {[
                { name: "Chat", active: true },
                { name: "Preview", badge: "LIVE" },
                { name: "Terminal" },
                { name: "Output" },
              ].map((tab) => (
                <button
                  key={tab.name}
                  className={`px-4 py-2 text-sm border-r border-white/5 flex items-center gap-2 transition ${
                    tab.active
                      ? "bg-[#1e1e1e] text-white border-t-2 border-t-violet-500"
                      : "text-white/50 hover:text-white hover:bg-white/5"
                  }`}
                >
                  {tab.name}
                  {tab.badge && (
                    <span className="px-1.5 py-0.5 bg-emerald-500/20 text-emerald-400 text-[10px] font-medium rounded">
                      {tab.badge}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Split Panels */}
          <div className="flex-1 flex overflow-hidden">
            {/* Chat Panel */}
            <div className="flex-1 flex flex-col border-r border-white/5">
              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                <IDEMessage
                  role="user"
                  content="The OAuth redirect is failing after login. Users are getting stuck on a blank page."
                />
                <IDEMessage
                  role="assistant"
                  content="I've identified the issue in `src/auth/callback.ts`. The redirect URL wasn't properly encoded. Pushing fix now..."
                />
                <div className="flex items-center gap-2 text-xs text-white/30 py-2">
                  <span className="w-4 h-4 border-2 border-white/20 border-t-violet-500 rounded-full animate-spin" />
                  Running tests...
                </div>
              </div>
              {/* Command Input */}
              <div className="p-3 border-t border-white/5">
                <div className="flex items-center gap-2 px-3 py-2 bg-white/5 rounded-lg border border-white/10 focus-within:border-violet-500/50">
                  <span className="text-violet-400 text-sm">&gt;</span>
                  <input
                    type="text"
                    placeholder="Enter command or prompt..."
                    className="flex-1 bg-transparent text-sm text-white placeholder:text-white/30 focus:outline-none"
                  />
                  <kbd className="px-1.5 py-0.5 bg-white/10 text-white/40 text-xs rounded">⏎</kbd>
                </div>
              </div>
            </div>

            {/* Preview Panel */}
            <div className="w-[45%] flex flex-col bg-[#1e1e1e]">
              <div className="flex items-center justify-between px-3 py-2 bg-[#252526] border-b border-white/5">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-xs text-white/60">localhost:5173</span>
                </div>
                <div className="flex items-center gap-1">
                  <button className="p-1.5 hover:bg-white/10 rounded transition">
                    <RefreshIcon className="w-3.5 h-3.5 text-white/40" />
                  </button>
                  <button className="p-1.5 hover:bg-white/10 rounded transition">
                    <ExternalLinkIcon className="w-3.5 h-3.5 text-white/40" />
                  </button>
                </div>
              </div>
              <div className="flex-1 p-4">
                <div className="h-full bg-white rounded-lg overflow-hidden shadow-2xl">
                  <div className="h-full flex items-center justify-center bg-gradient-to-br from-violet-50 to-white p-6">
                    <div className="text-center">
                      <div className="w-10 h-10 bg-violet-600 rounded-lg mx-auto mb-3 flex items-center justify-center">
                        <span className="text-white font-bold">A</span>
                      </div>
                      <h2 className="text-lg font-semibold text-gray-900">Sign In</h2>
                      <button className="mt-4 px-4 py-2 bg-gray-900 text-white text-sm rounded-lg">
                        Continue with GitHub
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Status Bar */}
          <div className="flex items-center justify-between px-3 py-1 bg-violet-600 text-white text-xs">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5">
                <GitIcon className="w-3.5 h-3.5" />
                fix/auth-redirect
              </span>
              <span>2 files changed</span>
            </div>
            <div className="flex items-center gap-4">
              <span>Claude Sonnet 3.5</span>
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-white" />
                Session active
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// VARIATION 3: FLOW
// Elegant conversation - minimal, focused, Linear-inspired
// ============================================================================
function FlowVariation() {
  return (
    <div className="h-full bg-white">
      {/* Minimal Top Bar */}
      <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 bg-white/80 backdrop-blur-xl border-b border-black/5">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-black flex items-center justify-center">
              <span className="text-white font-bold text-sm">O</span>
            </div>
            <span className="text-sm font-medium text-black/80">Open-Inspect</span>
          </div>
          <nav className="flex items-center gap-1">
            {["Sessions", "Activity"].map((item, i) => (
              <button
                key={item}
                className={`px-3 py-1.5 text-sm rounded-lg transition ${
                  i === 0
                    ? "bg-black/5 text-black"
                    : "text-black/40 hover:text-black hover:bg-black/5"
                }`}
              >
                {item}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <button className="flex items-center gap-2 px-3 py-1.5 border border-black/10 rounded-lg text-sm text-black/60 hover:border-black/20 transition">
            <PlusIcon className="w-4 h-4" />
            New Session
          </button>
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-400 to-indigo-500" />
        </div>
      </header>

      <div className="flex h-full pt-16">
        {/* Session Sidebar - Hoverable */}
        <aside className="w-72 border-r border-black/5 bg-[#fafafa] flex flex-col">
          <div className="p-4">
            <input
              type="text"
              placeholder="Search sessions..."
              className="w-full px-3 py-2 bg-white border border-black/10 rounded-lg text-sm placeholder:text-black/30 focus:outline-none focus:ring-2 focus:ring-black/10"
            />
          </div>
          <div className="flex-1 overflow-y-auto px-2">
            {[
              {
                title: "Fix auth redirect bug",
                repo: "anthropics/console",
                time: "2m",
                active: true,
              },
              {
                title: "Add dark mode toggle",
                repo: "anthropics/marketing",
                time: "1h",
                active: false,
              },
              {
                title: "Refactor API handlers",
                repo: "anthropics/backend",
                time: "3h",
                active: false,
              },
              { title: "Update documentation", repo: "anthropics/docs", time: "1d", active: false },
            ].map((session, i) => (
              <button
                key={i}
                className={`w-full p-3 rounded-xl text-left transition mb-1 ${
                  session.active ? "bg-white shadow-sm ring-1 ring-black/5" : "hover:bg-white/50"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-black/80 truncate">
                    {session.title}
                  </span>
                  <span className="text-xs text-black/30">{session.time}</span>
                </div>
                <span className="text-xs text-black/40 truncate block">{session.repo}</span>
              </button>
            ))}
          </div>
        </aside>

        {/* Main Conversation Area */}
        <main className="flex-1 flex flex-col max-w-3xl mx-auto w-full">
          {/* Session Header */}
          <div className="px-8 py-6 border-b border-black/5">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-xl font-semibold text-black">Fix auth redirect bug</h1>
                <p className="text-sm text-black/40 mt-1">anthropics/console • fix/auth-redirect</p>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex -space-x-2">
                  <div className="w-8 h-8 rounded-full bg-violet-100 ring-2 ring-white flex items-center justify-center text-violet-600 text-xs font-medium">
                    BJ
                  </div>
                  <div className="w-8 h-8 rounded-full bg-emerald-100 ring-2 ring-white flex items-center justify-center text-emerald-600 text-xs font-medium">
                    AI
                  </div>
                </div>
                <button className="px-4 py-2 bg-black text-white text-sm font-medium rounded-lg hover:bg-black/90 transition">
                  View PR
                </button>
              </div>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-8 py-6 space-y-6">
            <FlowMessage
              role="user"
              author="Brede"
              content="The OAuth redirect is failing after login. Users are getting stuck on a blank page. Can you investigate?"
            />
            <FlowMessage
              role="assistant"
              content="I found the issue. The callback URL in `src/auth/callback.ts` wasn't properly URL-encoded, which caused the redirect to fail when special characters were present in the state parameter."
            >
              <div className="mt-4 p-4 bg-black/[0.02] rounded-xl border border-black/5">
                <div className="flex items-center gap-2 text-xs text-black/40 mb-2">
                  <span>src/auth/callback.ts</span>
                  <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-600 rounded">
                    +2 -1
                  </span>
                </div>
                <pre className="text-xs text-black/60 font-mono overflow-x-auto">
                  {`- const redirectUrl = state.returnTo;
+ const redirectUrl = encodeURIComponent(state.returnTo);`}
                </pre>
              </div>
            </FlowMessage>
            <div className="flex items-center gap-4">
              <div className="h-px flex-1 bg-black/5" />
              <button className="flex items-center gap-2 px-3 py-1.5 bg-black/[0.02] rounded-full text-xs text-black/40 hover:bg-black/[0.04] transition">
                <PreviewIcon className="w-3.5 h-3.5" />
                View Screenshot
              </button>
              <div className="h-px flex-1 bg-black/5" />
            </div>
            <FlowMessage
              role="user"
              author="Brede"
              content="Perfect! Can you also add a loading spinner while the redirect is happening?"
            />
            <div className="flex items-center gap-3 text-black/40">
              <div className="flex space-x-1">
                <span
                  className="w-2 h-2 bg-black/20 rounded-full animate-bounce"
                  style={{ animationDelay: "0ms" }}
                />
                <span
                  className="w-2 h-2 bg-black/20 rounded-full animate-bounce"
                  style={{ animationDelay: "150ms" }}
                />
                <span
                  className="w-2 h-2 bg-black/20 rounded-full animate-bounce"
                  style={{ animationDelay: "300ms" }}
                />
              </div>
              <span className="text-sm">Thinking...</span>
            </div>
          </div>

          {/* Input Area */}
          <div className="px-8 py-6 border-t border-black/5">
            <div className="relative">
              <textarea
                placeholder="What would you like to build?"
                className="w-full px-5 py-4 pr-14 text-base bg-black/[0.02] border border-black/10 rounded-2xl resize-none focus:outline-none focus:ring-2 focus:ring-black/10 focus:border-transparent"
                rows={3}
              />
              <button className="absolute right-4 bottom-4 p-2 bg-black text-white rounded-xl hover:bg-black/80 transition">
                <ArrowUpIcon className="w-5 h-5" />
              </button>
            </div>
            <div className="flex items-center justify-between mt-4">
              <div className="flex items-center gap-4">
                <ModelBadge model="claude-sonnet" />
                <button className="text-sm text-black/40 hover:text-black transition flex items-center gap-1.5">
                  <AttachIcon className="w-4 h-4" />
                  Attach
                </button>
              </div>
              <div className="flex items-center gap-4">
                <button className="text-sm text-black/40 hover:text-black transition flex items-center gap-1.5">
                  <MicIcon className="w-4 h-4" />
                  Voice
                </button>
                <button className="text-sm text-black/40 hover:text-black transition flex items-center gap-1.5">
                  <SelectIcon className="w-4 h-4" />
                  Select Element
                </button>
              </div>
            </div>
          </div>
        </main>

        {/* Preview Side Panel (appears on hover/click) */}
        <aside className="w-80 border-l border-black/5 bg-[#fafafa] p-4">
          <div className="flex items-center justify-between mb-4">
            <span className="text-xs font-medium text-black/40 uppercase tracking-wider">
              Live Preview
            </span>
            <span className="flex items-center gap-1.5 text-xs text-emerald-600">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live
            </span>
          </div>
          <div className="bg-white rounded-xl overflow-hidden shadow-lg border border-black/5">
            <div className="h-48 flex items-center justify-center bg-gradient-to-br from-indigo-50 to-white p-4">
              <div className="text-center">
                <div className="w-8 h-8 bg-indigo-600 rounded-lg mx-auto mb-2 flex items-center justify-center">
                  <span className="text-white font-bold text-sm">A</span>
                </div>
                <p className="text-sm font-medium text-gray-900">Sign In</p>
              </div>
            </div>
          </div>
          <div className="mt-4">
            <span className="text-xs font-medium text-black/40 uppercase tracking-wider">
              Recent Screenshots
            </span>
            <div className="grid grid-cols-3 gap-2 mt-2">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <button
                  key={i}
                  className="aspect-video bg-white rounded-lg overflow-hidden border border-black/5 hover:border-black/20 transition"
                >
                  <div className="w-full h-full bg-gradient-to-br from-indigo-50 to-white" />
                </button>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ============================================================================
// VARIATION 4: DUAL FOCUS
// Equal chat/preview split - both always visible
// ============================================================================
function DualFocusVariation() {
  return (
    <div className="h-full flex flex-col bg-[#0f0f0f]">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center">
            <span className="text-white font-bold text-sm">O</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-white/90 font-medium">Fix auth redirect bug</span>
            <span className="text-white/30">•</span>
            <span className="text-white/40 text-sm">anthropics/console</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-white/5 rounded-full">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-white/60 text-xs">Sandbox ready</span>
          </div>
          <div className="flex -space-x-2">
            <div className="w-7 h-7 rounded-full bg-cyan-500 ring-2 ring-[#0f0f0f]" />
            <div className="w-7 h-7 rounded-full bg-violet-500 ring-2 ring-[#0f0f0f]" />
          </div>
          <button className="px-4 py-1.5 bg-white text-black text-sm font-medium rounded-full hover:bg-white/90 transition">
            View PR
          </button>
        </div>
      </header>

      {/* Main Split View */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Chat */}
        <div className="flex-1 flex flex-col border-r border-white/[0.06]">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-white/[0.06] bg-white/[0.02]">
            <ChatIcon className="w-4 h-4 text-white/40" />
            <span className="text-sm text-white/60">Conversation</span>
          </div>
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            <DualMessage
              role="user"
              content="The OAuth redirect is failing after login. Users are getting stuck on a blank page."
            />
            <DualMessage
              role="assistant"
              content="Found it! The callback URL wasn't properly URL-encoded in `src/auth/callback.ts`. I've fixed this and the redirect now works correctly. Check the preview to verify."
            />
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 text-emerald-400 rounded-full text-xs">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                Tests passing
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-cyan-500/10 text-cyan-400 rounded-full text-xs">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                Preview updated
              </div>
            </div>
            <DualMessage
              role="user"
              content="Great! Can you add a loading spinner during the redirect?"
            />
            <div className="flex items-center gap-2 text-white/30 text-sm">
              <span className="w-4 h-4 border-2 border-white/20 border-t-cyan-400 rounded-full animate-spin" />
              Implementing changes...
            </div>
          </div>
          {/* Input */}
          <div className="p-4 border-t border-white/[0.06]">
            <div className="flex items-end gap-3">
              <div className="flex-1 relative">
                <textarea
                  placeholder="Describe changes..."
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder:text-white/30 resize-none focus:outline-none focus:border-cyan-500/50"
                  rows={2}
                />
              </div>
              <button className="p-3 bg-cyan-500 text-white rounded-xl hover:bg-cyan-400 transition">
                <ArrowUpIcon className="w-5 h-5" />
              </button>
            </div>
            <div className="flex items-center justify-between mt-3 text-xs">
              <ModelBadge model="claude-sonnet" dark />
              <div className="flex items-center gap-3 text-white/40">
                <button className="hover:text-white transition flex items-center gap-1">
                  <MicIcon className="w-3.5 h-3.5" /> Voice
                </button>
                <button className="hover:text-white transition flex items-center gap-1">
                  <AttachIcon className="w-3.5 h-3.5" /> Attach
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Preview */}
        <div className="flex-1 flex flex-col bg-[#0a0a0a]">
          <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.06] bg-white/[0.02]">
            <div className="flex items-center gap-2">
              <PreviewIcon className="w-4 h-4 text-white/40" />
              <span className="text-sm text-white/60">Live Preview</span>
              <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 text-[10px] font-medium rounded-full">
                LIVE
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button className="p-2 hover:bg-white/10 rounded-lg transition">
                <RefreshIcon className="w-4 h-4 text-white/40" />
              </button>
              <button className="p-2 hover:bg-white/10 rounded-lg transition">
                <SelectIcon className="w-4 h-4 text-white/40" />
              </button>
              <button className="p-2 hover:bg-white/10 rounded-lg transition">
                <ExternalLinkIcon className="w-4 h-4 text-white/40" />
              </button>
            </div>
          </div>
          <div className="flex-1 p-6">
            <div className="h-full bg-white rounded-2xl overflow-hidden shadow-2xl shadow-black/50">
              <div className="h-6 bg-gray-100 flex items-center px-3 gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
                <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
                <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
              </div>
              <div className="h-[calc(100%-24px)] flex items-center justify-center bg-gradient-to-br from-cyan-50 via-white to-blue-50 p-8">
                <div className="w-full max-w-sm">
                  <div className="text-center mb-6">
                    <div className="w-14 h-14 bg-gradient-to-br from-cyan-500 to-blue-600 rounded-2xl mx-auto mb-4 flex items-center justify-center shadow-lg shadow-cyan-500/25">
                      <span className="text-white font-bold text-xl">A</span>
                    </div>
                    <h2 className="text-2xl font-semibold text-gray-900">Welcome back</h2>
                    <p className="text-gray-500 mt-1">Sign in to continue</p>
                  </div>
                  <button className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-gray-900 text-white rounded-xl font-medium">
                    <GitHubIcon className="w-5 h-5" />
                    Continue with GitHub
                  </button>
                  <div className="mt-4 flex items-center justify-center gap-2 text-sm text-cyan-600">
                    <span className="w-4 h-4 border-2 border-cyan-600 border-t-transparent rounded-full animate-spin" />
                    Redirecting...
                  </div>
                </div>
              </div>
            </div>
          </div>
          {/* Screenshot Timeline */}
          <div className="px-4 pb-4">
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
                <button
                  key={i}
                  className={`flex-shrink-0 w-20 h-12 rounded-lg overflow-hidden transition ${
                    i === 10 ? "ring-2 ring-cyan-500" : "opacity-50 hover:opacity-100"
                  }`}
                >
                  <div className="w-full h-full bg-gradient-to-br from-cyan-100 to-white" />
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// VARIATION 5: AMBIENT
// Dark immersive - screenshots as art, subtle UI
// ============================================================================
function AmbientVariation() {
  return (
    <div className="h-full bg-[#09090b] flex flex-col">
      {/* Minimal Header */}
      <header className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-rose-500 to-orange-400" />
          <div>
            <h1 className="text-white/90 font-medium">Fix auth redirect bug</h1>
            <p className="text-white/30 text-xs">anthropics/console</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-2 text-xs text-white/40">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            Connected
          </span>
          <button className="px-4 py-1.5 bg-white/10 text-white/80 text-sm rounded-full hover:bg-white/20 transition">
            View PR
          </button>
        </div>
      </header>

      {/* Main Content - Preview Dominant */}
      <main className="flex-1 flex overflow-hidden">
        {/* Floating Session List */}
        <aside className="absolute left-4 top-20 bottom-24 w-56 bg-white/[0.03] backdrop-blur-2xl rounded-2xl border border-white/[0.06] p-3 z-10 opacity-30 hover:opacity-100 transition-opacity">
          <div className="space-y-1">
            {[
              { name: "Fix auth redirect", active: true },
              { name: "Add dark mode", active: false },
              { name: "Refactor API", active: false },
            ].map((s, i) => (
              <button
                key={i}
                className={`w-full px-3 py-2 rounded-xl text-left text-sm transition ${
                  s.active
                    ? "bg-white/10 text-white"
                    : "text-white/40 hover:text-white/60 hover:bg-white/5"
                }`}
              >
                {s.name}
              </button>
            ))}
          </div>
        </aside>

        {/* Preview Hero */}
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="relative w-full max-w-4xl aspect-[16/10]">
            {/* Glow Effect */}
            <div className="absolute inset-0 bg-gradient-to-br from-rose-500/20 to-orange-500/20 rounded-3xl blur-3xl" />
            {/* Preview Frame */}
            <div className="relative h-full bg-white rounded-2xl overflow-hidden shadow-2xl shadow-black/50">
              <div className="h-8 bg-gray-100 flex items-center px-4 gap-2">
                <span className="w-3 h-3 rounded-full bg-red-400" />
                <span className="w-3 h-3 rounded-full bg-yellow-400" />
                <span className="w-3 h-3 rounded-full bg-green-400" />
                <span className="flex-1 text-center text-xs text-gray-400">
                  localhost:5173/login
                </span>
              </div>
              <div className="h-[calc(100%-32px)] flex items-center justify-center bg-gradient-to-br from-rose-50 via-white to-orange-50 p-12">
                <div className="w-full max-w-md">
                  <div className="text-center mb-8">
                    <div className="w-16 h-16 bg-gradient-to-br from-rose-500 to-orange-400 rounded-2xl mx-auto mb-5 flex items-center justify-center shadow-xl shadow-rose-500/30">
                      <span className="text-white font-bold text-2xl">A</span>
                    </div>
                    <h2 className="text-3xl font-semibold text-gray-900">Welcome back</h2>
                    <p className="text-gray-500 mt-2 text-lg">Sign in to your account</p>
                  </div>
                  <button className="w-full flex items-center justify-center gap-3 px-6 py-4 bg-gray-900 text-white rounded-xl font-medium text-lg hover:bg-gray-800 transition">
                    <GitHubIcon className="w-6 h-6" />
                    Continue with GitHub
                  </button>
                  <div className="mt-6 flex items-center justify-center gap-2 text-rose-500">
                    <span className="w-5 h-5 border-2 border-rose-500 border-t-transparent rounded-full animate-spin" />
                    <span>Redirecting...</span>
                  </div>
                </div>
              </div>
            </div>
            {/* Live Badge */}
            <div className="absolute top-4 right-4 flex items-center gap-2 px-3 py-1.5 bg-black/60 backdrop-blur-xl rounded-full">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-white/80 text-xs font-medium">Live Preview</span>
            </div>
          </div>
        </div>

        {/* Floating Chat */}
        <aside className="absolute right-4 top-20 bottom-24 w-96 bg-white/[0.03] backdrop-blur-2xl rounded-2xl border border-white/[0.06] flex flex-col z-10">
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <AmbientMessage
              role="user"
              content="The OAuth redirect is failing after login. Users are stuck on a blank page."
            />
            <AmbientMessage
              role="assistant"
              content="Found the issue in src/auth/callback.ts - the redirect URL wasn't properly encoded. Fixed it and pushed. Check the preview!"
            />
            <AmbientMessage
              role="user"
              content="Can you add a loading spinner during the redirect?"
            />
            <div className="flex items-center gap-2 text-white/30 text-sm px-4 py-2">
              <span className="w-4 h-4 border-2 border-white/20 border-t-rose-400 rounded-full animate-spin" />
              Working on it...
            </div>
          </div>
          {/* Input */}
          <div className="p-4 border-t border-white/[0.06]">
            <div className="relative">
              <textarea
                placeholder="What would you like to build?"
                className="w-full px-4 py-3 pr-12 bg-white/5 border border-white/10 rounded-xl text-white placeholder:text-white/30 resize-none focus:outline-none focus:border-rose-500/50 text-sm"
                rows={2}
              />
              <button className="absolute right-3 bottom-3 p-2 bg-gradient-to-br from-rose-500 to-orange-400 text-white rounded-lg">
                <ArrowUpIcon className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center justify-between mt-3">
              <ModelBadge model="claude-sonnet" dark />
              <div className="flex items-center gap-2 text-white/40 text-xs">
                <button className="hover:text-white transition">
                  <MicIcon className="w-4 h-4" />
                </button>
                <button className="hover:text-white transition">
                  <AttachIcon className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </aside>
      </main>

      {/* Screenshot Timeline - Bottom */}
      <div className="px-8 pb-6">
        <div className="flex items-center gap-3 overflow-x-auto">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => (
            <button
              key={i}
              className={`flex-shrink-0 w-28 h-16 rounded-xl overflow-hidden transition-all ${
                i === 12
                  ? "ring-2 ring-rose-500 scale-105"
                  : "opacity-40 hover:opacity-80 hover:scale-102"
              }`}
            >
              <div className="w-full h-full bg-gradient-to-br from-rose-100 to-orange-50" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// SHARED COMPONENTS
// ============================================================================

function MessageBubble({
  role,
  content,
  time,
}: {
  role: "user" | "assistant";
  content: string;
  time: string;
}) {
  return (
    <div className={`flex flex-col ${role === "user" ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[85%] px-4 py-3 rounded-2xl ${
          role === "user"
            ? "bg-black text-white rounded-br-md"
            : "bg-black/[0.04] text-black/80 rounded-bl-md"
        }`}
      >
        <p className="text-sm">{content}</p>
      </div>
      <span className="text-xs text-black/30 mt-1 px-1">{time}</span>
    </div>
  );
}

function IDEMessage({ role, content }: { role: "user" | "assistant"; content: string }) {
  return (
    <div className={`flex gap-3 ${role === "user" ? "flex-row-reverse" : ""}`}>
      <div
        className={`w-7 h-7 rounded flex-shrink-0 flex items-center justify-center text-xs font-medium ${
          role === "user" ? "bg-blue-500 text-white" : "bg-violet-500 text-white"
        }`}
      >
        {role === "user" ? "U" : "AI"}
      </div>
      <div
        className={`flex-1 px-4 py-3 rounded-lg text-sm ${
          role === "user" ? "bg-blue-500/10 text-blue-100" : "bg-white/5 text-white/80"
        }`}
      >
        {content}
      </div>
    </div>
  );
}

function FlowMessage({
  role,
  content,
  author,
  children,
}: {
  role: "user" | "assistant";
  content: string;
  author?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <div
        className={`w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center text-sm font-medium ${
          role === "user" ? "bg-violet-100 text-violet-600" : "bg-emerald-100 text-emerald-600"
        }`}
      >
        {role === "user" ? author?.charAt(0) || "U" : "AI"}
      </div>
      <div className="flex-1">
        {author && <span className="text-sm font-medium text-black/80 mb-1 block">{author}</span>}
        <p className="text-black/70 leading-relaxed">{content}</p>
        {children}
      </div>
    </div>
  );
}

function DualMessage({ role, content }: { role: "user" | "assistant"; content: string }) {
  return (
    <div className={`flex gap-3 ${role === "user" ? "flex-row-reverse" : ""}`}>
      <div
        className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-medium ${
          role === "user" ? "bg-cyan-500" : "bg-violet-500"
        } text-white`}
      >
        {role === "user" ? "B" : "AI"}
      </div>
      <div
        className={`max-w-[80%] px-4 py-3 rounded-2xl text-sm ${
          role === "user"
            ? "bg-cyan-500/20 text-cyan-100 rounded-tr-md"
            : "bg-white/10 text-white/80 rounded-tl-md"
        }`}
      >
        {content}
      </div>
    </div>
  );
}

function AmbientMessage({ role, content }: { role: "user" | "assistant"; content: string }) {
  return (
    <div className={`px-4 py-3 rounded-xl ${role === "user" ? "bg-white/10" : "bg-white/5"}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className={`text-xs font-medium ${role === "user" ? "text-rose-400" : "text-white/40"}`}
        >
          {role === "user" ? "You" : "Agent"}
        </span>
      </div>
      <p className="text-sm text-white/70">{content}</p>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-black/40 text-sm">
      <span className="w-2 h-2 bg-black/20 rounded-full animate-pulse" />
      <span>Thinking...</span>
    </div>
  );
}

function ModelBadge({ model, dark }: { model: string; dark?: boolean }) {
  const modelName = model === "claude-sonnet" ? "Claude Sonnet" : model;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium ${
        dark ? "bg-white/10 text-white/60" : "bg-black/5 text-black/50"
      }`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-violet-500" />
      {modelName}
    </span>
  );
}

// Icons
function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function ArrowUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 10l7-7m0 0l7 7m-7-7v18"
      />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  );
}

function SelectIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122"
      />
    </svg>
  );
}

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
      />
    </svg>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
      />
    </svg>
  );
}

function AttachIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
      />
    </svg>
  );
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
      />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
      />
    </svg>
  );
}

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
      />
    </svg>
  );
}

function PreviewIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
      />
    </svg>
  );
}

function GitIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3" strokeWidth={2} />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v6m0 6v6" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      />
    </svg>
  );
}
