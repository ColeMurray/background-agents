import { Button } from "@/components/ui/button";

interface AuthGateProps {
  onRetry: () => void;
}

export function AuthGate({ onRetry }: AuthGateProps) {
  const openLogin = () => {
    chrome.runtime.sendMessage({ type: "WRENCH_OPEN_LOGIN" });
  };

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-clay-100 px-6">
      <div className="text-center space-y-6 max-w-xs">
        {/* logo */}
        <div className="flex items-center justify-center gap-2 mb-2">
          <svg
            className="w-8 h-8 text-rebolt-500"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
          <h1 className="text-2xl font-semibold text-ash-900 font-clash">Wrench</h1>
        </div>

        <p className="text-ash-500 text-sm">
          Sign in to your Wrench account to start coding sessions from your browser.
        </p>

        <Button variant="rebolt-primary" size="xs" onClick={openLogin} className="w-full">
          Sign in with GitHub
        </Button>

        <Button variant="link" size="xs" onClick={onRetry}>
          Already signed in? Click to refresh
        </Button>
      </div>
    </div>
  );
}
