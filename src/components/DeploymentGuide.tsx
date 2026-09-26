import { CheckCircle2, ExternalLink, ArrowRight, Cloud, Zap, Database, Key } from 'lucide-react';

export default function DeploymentGuide() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white mb-4">Dashboard Deployment Guide</h2>
        <p className="text-gray-400 leading-relaxed">
          Deploy Hopr to Cloudflare using only the web dashboard. No CLI required.
        </p>
      </div>

      {/* Part 1: Pages */}
      <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-gradient-to-br from-orange-500 to-orange-600 rounded-xl flex items-center justify-center">
            <Cloud className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="text-xl font-semibold text-white">Part 1: Deploy Frontend (Cloudflare Pages)</h3>
            <p className="text-sm text-gray-400">Host the React dashboard on Cloudflare's global edge network</p>
          </div>
        </div>

        <div className="space-y-6">
          <DeployStep
            number={1}
            title="Build the project locally"
            description="Run these commands in your terminal to build the production bundle:"
            code={`npm install
npm run build`}
          />

          <DeployStep
            number={2}
            title="Go to Cloudflare Dashboard"
            description="Navigate to the Pages section:"
            link="https://dash.cloudflare.com/?to=/:account/pages"
            linkText="dash.cloudflare.com → Workers & Pages → Pages"
          />

          <DeployStep
            number={3}
            title="Create a new Pages project"
            description="Click 'Create a project' → 'Upload assets' (direct upload)"
          />

          <DeployStep
            number={4}
            title="Configure project"
            description="Fill in the project details:"
            details={[
              { label: 'Project name', value: 'hopr' },
              { label: 'Production branch', value: 'main' },
            ]}
          />

          <DeployStep
            number={5}
            title="Upload the dist folder"
            description="Drag and drop the entire 'dist' folder from your local build into the upload area"
          />

          <DeployStep
            number={6}
            title="Deploy"
            description="Click 'Deploy site'. Your frontend will be live at:"
            code="https://hopr.pages.dev"
          />
        </div>
      </div>

      {/* Part 2: Workers */}
      <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-purple-600 rounded-xl flex items-center justify-center">
            <Zap className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="text-xl font-semibold text-white">Part 2: Deploy Backend (Cloudflare Workers)</h3>
            <p className="text-sm text-gray-400">Deploy the API worker for chain detection and trade execution</p>
          </div>
        </div>

        <div className="space-y-6">
          <DeployStep
            number={1}
            title="Go to Workers & Pages"
            description="Navigate to the Workers section:"
            link="https://dash.cloudflare.com/?to=/:account/workers"
            linkText="dash.cloudflare.com → Workers & Pages → Workers"
          />

          <DeployStep
            number={2}
            title="Create a new Worker"
            description="Click 'Create Worker' → 'Deploy' (use the default hello-world template)"
          />

          <DeployStep
            number={3}
            title="Edit the Worker code"
            description="Click 'Edit Code' and replace the entire contents with the code from workers/index.ts"
          />

          <DeployStep
            number={4}
            title="Configure Worker settings"
            description="Go to Settings → General and configure:"
            details={[
              { label: 'Worker name', value: 'hopr-api' },
              { label: 'Compatibility date', value: '2024-01-01' },
            ]}
          />

          <DeployStep
            number={5}
            title="Set environment variables"
            description="Go to Settings → Variables and add these secrets:"
            details={[
              { label: 'ENCRYPTION_KEY', value: 'Your AES-256-GCM encryption key (generate a secure random key)' },
              { label: 'LIFI_API_KEY', value: 'Your LI.FI API key from https://li.quest' },
              { label: 'ENVIRONMENT', value: 'production' },
            ]}
          />

          <DeployStep
            number={6}
            title="Deploy the Worker"
            description="Click 'Save and Deploy'. Your API will be live at:"
            code="https://hopr-api.your-subdomain.workers.dev"
          />
        </div>
      </div>

      {/* Part 3: D1 Database */}
      <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl flex items-center justify-center">
            <Database className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="text-xl font-semibold text-white">Part 3: Create D1 Database (Optional)</h3>
            <p className="text-sm text-gray-400">Store user data, trades, and wallet information</p>
          </div>
        </div>

        <div className="space-y-6">
          <DeployStep
            number={1}
            title="Go to D1 SQL Database"
            description="Navigate to the D1 section:"
            link="https://dash.cloudflare.com/?to=/:account/workers/d1"
            linkText="dash.cloudflare.com → Workers & Pages → D1 SQL Database"
          />

          <DeployStep
            number={2}
            title="Create a new database"
            description="Click 'Create database' and configure:"
            details={[
              { label: 'Database name', value: 'hopr-db' },
            ]}
          />

          <DeployStep
            number={3}
            title="Bind database to Worker"
            description="Go to your Worker → Settings → Bindings → Add → D1 Database"
            details={[
              { label: 'Variable name', value: 'DB' },
              { label: 'D1 database', value: 'hopr-db' },
            ]}
          />

          <DeployStep
            number={4}
            title="Run migrations"
            description="Use the D1 console to run SQL migrations:"
            code={`CREATE TABLE users (
  id TEXT PRIMARY KEY,
  telegram_id TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chain_type TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE user_trades (
  trade_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  target_token_address TEXT NOT NULL,
  target_chain_id INTEGER NOT NULL,
  purchased_amount TEXT NOT NULL,
  funding_chain_id TEXT NOT NULL,
  funding_token_address TEXT NOT NULL,
  status TEXT NOT NULL,
  bridge_tx_hash TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);`}
          />
        </div>
      </div>

      {/* Part 4: KV Cache */}
      <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-gradient-to-br from-green-500 to-green-600 rounded-xl flex items-center justify-center">
            <Key className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="text-xl font-semibold text-white">Part 4: Create KV Namespace (Optional)</h3>
            <p className="text-sm text-gray-400">Cache chain detection results for faster responses</p>
          </div>
        </div>

        <div className="space-y-6">
          <DeployStep
            number={1}
            title="Go to KV"
            description="Navigate to the KV section:"
            link="https://dash.cloudflare.com/?to=/:account/workers/kv"
            linkText="dash.cloudflare.com → Workers & Pages → KV"
          />

          <DeployStep
            number={2}
            title="Create a new namespace"
            description="Click 'Create a namespace' and name it:"
            details={[
              { label: 'Namespace name', value: 'hopr-cache' },
            ]}
          />

          <DeployStep
            number={3}
            title="Bind KV to Worker"
            description="Go to your Worker → Settings → Bindings → Add → KV Namespace"
            details={[
              { label: 'Variable name', value: 'CACHE' },
              { label: 'KV namespace', value: 'hopr-cache' },
            ]}
          />
        </div>
      </div>

      {/* Part 5: Custom Domain */}
      <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-indigo-600 rounded-xl flex items-center justify-center">
            <ExternalLink className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="text-xl font-semibold text-white">Part 5: Custom Domain (Optional)</h3>
            <p className="text-sm text-gray-400">Use your own domain instead of .pages.dev</p>
          </div>
        </div>

        <div className="space-y-6">
          <DeployStep
            number={1}
            title="Go to your Pages project"
            description="Navigate to your Pages project settings:"
            link="https://dash.cloudflare.com/?to=/:account/pages"
            linkText="dash.cloudflare.com → Workers & Pages → Pages → hopr"
          />

          <DeployStep
            number={2}
            title="Add custom domain"
            description="Go to Custom domains → Set up a custom domain"
            details={[
              { label: 'Domain', value: 'hopr.yourdomain.com' },
            ]}
          />

          <DeployStep
            number={3}
            title="Configure DNS"
            description="Cloudflare will automatically create the DNS records if your domain is on Cloudflare. Otherwise, add a CNAME record pointing to hopr.pages.dev"
          />

          <DeployStep
            number={4}
            title="Enable HTTPS"
            description="Cloudflare automatically provisions SSL certificates. Your site will be live at your custom domain with HTTPS."
          />
        </div>
      </div>

      {/* Summary */}
      <div className="bg-gradient-to-br from-purple-500/10 to-blue-500/10 border border-purple-500/20 rounded-2xl p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Deployment Summary</h3>
        <div className="space-y-3">
          <SummaryItem label="Frontend URL" value="https://hopr.pages.dev" />
          <SummaryItem label="Backend API" value="https://hopr-api.your-subdomain.workers.dev" />
          <SummaryItem label="Database" value="hopr-db (D1)" />
          <SummaryItem label="Cache" value="hopr-cache (KV)" />
        </div>
        <div className="mt-6 p-4 bg-gray-900/60 rounded-xl">
          <p className="text-sm text-gray-400">
            <span className="text-purple-400 font-medium">Note:</span> After initial deployment, you can update the frontend by re-uploading the dist folder, and update the Worker by editing the code in the dashboard. No CLI required for ongoing updates.
          </p>
        </div>
      </div>
    </div>
  );
}

function DeployStep({
  number,
  title,
  description,
  code,
  link,
  linkText,
  details,
}: {
  number: number;
  title: string;
  description: string;
  code?: string;
  link?: string;
  linkText?: string;
  details?: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex-shrink-0 w-8 h-8 bg-gradient-to-br from-purple-500/20 to-blue-500/20 border border-purple-500/30 rounded-xl flex items-center justify-center">
        <span className="text-sm font-bold text-purple-400">{number}</span>
      </div>
      <div className="flex-1">
        <h4 className="text-sm font-semibold text-white mb-1">{title}</h4>
        <p className="text-xs text-gray-400 leading-relaxed mb-2">{description}</p>
        
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 transition-colors mb-2"
          >
            <ExternalLink className="w-3 h-3" />
            {linkText}
          </a>
        )}

        {code && (
          <pre className="text-xs text-gray-300 bg-gray-800/50 rounded-lg p-3 overflow-x-auto font-mono mb-2">
            {code}
          </pre>
        )}

        {details && (
          <div className="space-y-1">
            {details.map((detail, idx) => (
              <div key={idx} className="flex items-start gap-2 text-xs">
                <span className="text-gray-500 font-mono">{detail.label}:</span>
                <span className="text-gray-300">{detail.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between p-3 bg-gray-900/60 rounded-xl">
      <span className="text-sm text-gray-400">{label}</span>
      <code className="text-sm text-purple-400 font-mono">{value}</code>
    </div>
  );
}
