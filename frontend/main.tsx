import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Activity, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, BadgeCheck, ChevronRight, CircleHelp, ClipboardCheck,
  Copy, Database, LayoutDashboard, List, Plus, RefreshCw, Search, Wallet as WalletIcon, X } from 'lucide-react';
import { api, failureLabels, formatMoney, statusLabels, type Entry, type Kind, type Ledger, type Reconciliation,
  type Transaction, type Wager, type Wallet } from './api';
import './generated.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const shortId = (id: string) => id.slice(0, 8) + '…' + id.slice(-4);
const pathFor = (id: string) => '/wallets/' + encodeURIComponent(id);
const kinds: Kind[] = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'];
const dateFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
type Page = 'overview' | 'ledger' | 'transactions';
type Modal = 'wallet' | 'open' | 'wager' | null;

const nav = [
  { id: 'overview', title: 'Visão geral', icon: LayoutDashboard },
  { id: 'ledger', title: 'Extrato', icon: List },
  { id: 'transactions', title: 'Transações', icon: ArrowLeftRight },
] as const;

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={error ? 'notice error' : 'notice'} role={error ? 'alert' : 'status'}>{children}</div>;
}

function Field({ label, name, initial, placeholder, required = true }: {
  label: string; name: string; initial?: string; placeholder?: string; required?: boolean;
}) {
  return <label className="field">{label}
    <input name={name} defaultValue={initial} placeholder={placeholder} required={required}
      inputMode={name === 'amount' ? 'decimal' : 'text'} spellCheck={false} />
  </label>;
}

function ModalForm({ title, description, close, children }: { title: string; description: string; close: () => void; children: ReactNode }) {
  return <Dialog.Root open onOpenChange={open => { if (!open) close(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="overlay" />
      <Dialog.Content className="dialog">
        <div className="dialog-heading">
          <div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div>
          <Dialog.Close className="icon-button" aria-label="Fechar"><X size={18} /></Dialog.Close>
        </div>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function TransactionResult({ transaction }: { transaction: Transaction }) {
  return <div className="result">
    <div className="result-top">
      <span className={'pill ' + (transaction.status === 'PROCESSED' ? 'success' : transaction.status === 'REJECTED' || transaction.status === 'FAILED' ? 'danger' : 'warning')}>
        <span />{statusLabels[transaction.status] ?? transaction.status}
      </span>
      {transaction.idempotentReplay && <span className="pill">Replay idempotente</span>}
    </div>
    {transaction.failureCode && <p>{failureLabels[transaction.failureCode] ?? transaction.failureCode}</p>}
    <dl><dt>Transação</dt><dd className="mono">{transaction.transactionId}</dd><dt>Saldo no processamento</dt><dd className="mono">{formatMoney(transaction.balance)}</dd></dl>
  </div>;
}

function WagerForm({ wallet, submit, busy, error, result }: { wallet: Wallet; submit: (wager: Wager, key: string) => void; busy: boolean; error?: Error | null; result?: Transaction }) {
  const [kind, setKind] = useState<Kind>('BET');
  const [externalId] = useState(() => crypto.randomUUID());
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    const providerId = value('provider'), externalTransactionId = value('external');
    const reference = value('reference');
    submit({
      walletId: wallet.id, playerId: wallet.playerId, providerId, externalTransactionId, kind,
      roundId: value('round'), gameId: value('game'),
      money: { amount: value('amount').replace(',', '.'), currency: wallet.balance.currency },
      ...(reference ? { referenceExternalTransactionId: reference } : {}),
    }, value('key') || providerId + ':' + externalTransactionId);
  }
  return <form onSubmit={onSubmit} className="form">
    <div className="form-grid">
      <label className="field">Operação<select value={kind} onChange={event => setKind(event.target.value as Kind)}>{kinds.map(item => <option key={item}>{item}</option>)}</select></label>
      <Field name="amount" label={'Valor (' + wallet.balance.currency + ')'} initial="10.00" />
      <Field name="provider" label="Provedor" initial="console-local" />
      <Field name="external" label="ID externo" initial={externalId} />
      <Field name="round" label="Rodada" initial="rodada-1" />
      <Field name="game" label="Jogo" initial="demo" />
    </div>
    {(kind === 'WIN' || kind === 'REFUND' || kind === 'ROLLBACK') &&
      <Field name="reference" label="ID externo da referência" required={kind !== 'WIN'} />}
    <Field name="key" label="Chave de idempotência (opcional)" placeholder="Usa provedor:ID externo por padrão" required={false} />
    {error && <Notice error>{error.message}</Notice>}
    {result && <TransactionResult transaction={result} />}
    <button className="button primary" disabled={busy}>{busy ? 'Enviando…' : 'Enviar transação'}<ArrowUpRight size={16} /></button>
  </form>;
}

function LedgerPanel({ rows, next, loading, error, expand, isExpanded, onTransaction }: {
  rows: Entry[]; next?: () => void; loading: boolean; error?: Error | null;
  expand: () => void; isExpanded: boolean; onTransaction: (id: string) => void;
}) {
  return <section className="card ledger">
    <div className="card-heading"><div><h2>{isExpanded ? 'Lançamentos' : 'Atividade da carteira'}</h2><p>Movimentações registradas no extrato.</p></div>
      {!isExpanded && <button className="button secondary small" onClick={expand}>Ver extrato <ChevronRight size={15} /></button>}
    </div>
    {error ? <Notice error>{error.message}</Notice> : rows.length ? <div className="table-wrap overflow-auto">
      <table><thead><tr><th>Movimentação</th><th>Transação</th><th>Valor</th><th>Saldo após</th><th>Data e hora</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        <td><span className={'movement ' + row.direction.toLowerCase()}><span>{row.direction === 'CREDIT' ? <ArrowDownLeft size={15}/> : <ArrowUpRight size={15}/>}</span>{row.direction === 'CREDIT' ? 'Crédito' : 'Débito'}</span></td>
        <td><button className="transaction-link mono" title={row.transactionId} onClick={() => onTransaction(row.transactionId)}>{shortId(row.transactionId)}</button></td>
        <td className={'mono ' + (row.direction === 'CREDIT' ? 'positive' : '')}>{row.direction === 'CREDIT' ? '+' : '−'}{formatMoney(row.money)}</td>
        <td className="mono">{formatMoney(row.balanceAfter)}</td>
        <td>{dateFormat.format(new Date(row.createdAt))}</td>
      </tr>)}</tbody></table>
    </div> : <div className="empty"><List size={22}/><p>{loading ? 'Carregando extrato…' : 'Nenhum lançamento nesta carteira.'}</p></div>}
    {next && isExpanded && <div className="table-footer"><button className="button secondary small" onClick={next} disabled={loading}>{loading ? 'Carregando…' : 'Carregar mais'}</button></div>}
  </section>;
}

function App() {
  const client = useQueryClient();
  const [walletId, setWalletId] = useState(() => new URLSearchParams(location.search).get('wallet') ?? localStorage.getItem('gltech.wallet') ?? '');
  const [page, setPage] = useState<Page>('overview');
  const [modal, setModal] = useState<Modal>(null);
  const [newPlayerId, setNewPlayerId] = useState('');
  const [copied, setCopied] = useState(false);
  const [lookup, setLookup] = useState<string | null>(null);
  const [lookupMode, setLookupMode] = useState<'internal' | 'provider'>('internal');
  const [recheck, setRecheck] = useState<string | null>(null);
  const health = useQuery({ queryKey: ['health'], queryFn: () => api<{status: string}>('/health/ready'), refetchInterval: 10000 });
  const walletQuery = useQuery({ queryKey: ['wallet', walletId], queryFn: () => api<Wallet>(pathFor(walletId)), enabled: Boolean(walletId) });
  const wallet = walletQuery.data;
  const ledger = useInfiniteQuery({
    queryKey: ['ledger', walletId], initialPageParam: '', enabled: Boolean(wallet),
    queryFn: ({ pageParam }) => api<Ledger>(pathFor(walletId) + '/ledger?limit=10' + (pageParam ? '&cursor=' + encodeURIComponent(pageParam) : '')),
    getNextPageParam: last => last.nextCursor ?? undefined,
  });
  const rows = ledger.data?.pages.flatMap(list => list.entries) ?? [];
  const details = useQuery({
    queryKey: ['transaction', lookup], enabled: Boolean(lookup), queryFn: () => api<Transaction>(lookup!),
    refetchInterval: state => state.state.data?.status.startsWith('PENDING') ? 1500 : false,
  });
  const current = useQuery({
    queryKey: ['submitted', recheck], enabled: Boolean(recheck), queryFn: () => api<Transaction>('/wagering/transactions/' + recheck),
    refetchInterval: state => state.state.data === undefined || state.state.data.status.startsWith('PENDING') ? 1500 : false,
  });
  const reconcile = useMutation({ mutationFn: (id: string) => api<Reconciliation>(pathFor(id) + '/reconciliation', { body: {} }) });
  const settledStatus = current.data?.status;
  useEffect(() => {
    if (!settledStatus || settledStatus.startsWith('PENDING')) return;
    void client.invalidateQueries({ queryKey: ['wallet', walletId] });
    void client.invalidateQueries({ queryKey: ['ledger', walletId] });
  }, [client, walletId, settledStatus]);
  const refreshWallet = (id: string) => {
    void client.invalidateQueries({ queryKey: ['wallet', id] });
    void client.invalidateQueries({ queryKey: ['ledger', id] });
  };
  function selectWallet(id: string) {
    setWalletId(id); setCopied(false); setPage('overview'); setModal(null); reconcile.reset();
    localStorage.setItem('gltech.wallet', id);
    const url = new URL(location.href); url.searchParams.set('wallet', id); history.replaceState(null, '', url);
  }
  const createWallet = useMutation({
    mutationFn: (body: { playerId: string; initialBalance: { amount: string; currency: string } }) => api<Wallet>('/wallets', { body }),
    onSuccess: opened => { client.setQueryData(['wallet', opened.id], opened); selectWallet(opened.id); },
  });
  const openWallet = useMutation({
    mutationFn: (id: string) => api<Wallet>(pathFor(id)), onSuccess: opened => selectWallet(opened.id),
  });
  const send = useMutation({
    mutationFn: ({ wager, key }: { wager: Wager; key: string }) => api<Transaction>('/wagering/transactions', { body: wager, key, allowTerminalOutcome: true }),
    onSuccess: (result, variables) => {
      setRecheck(result.status.startsWith('PENDING') ? result.transactionId : null);
      reconcile.reset();
      refreshWallet(variables.wager.walletId);
    },
  });
  const submitted = current.data?.transactionId === send.data?.transactionId ? current.data : send.data;

  function showModal(next: Modal) {
    if (next === 'wallet') setNewPlayerId(crypto.randomUUID());
    createWallet.reset(); openWallet.reset(); send.reset(); setRecheck(null); setModal(next);
  }
  function inspect(id: string) { setLookup('/wagering/transactions/' + encodeURIComponent(id)); setPage('transactions'); }
  async function copyWallet() {
    if (!wallet) return;
    try { await navigator.clipboard.writeText(wallet.id); setCopied(true); } catch { setCopied(false); }
  }
  const pageTitle = nav.find(item => item.id === page)!.title;

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon"><Activity size={20}/></div><div><strong>GLTech</strong><span>Console de operações</span></div></div>
      <nav aria-label="Operações">{nav.map(({ id, title, icon: Icon }) =>
        <button key={id} className={id === page ? 'active' : ''} aria-current={id === page ? 'page' : undefined} onClick={() => setPage(id)}><Icon size={17}/>{title}</button>
      )}</nav>
      <div className="sidebar-footer"><Database size={16}/><div>Ambiente local<span>Distributed Wagering Processor</span></div></div>
    </aside>
    <div className="content">
      <header className="topbar"><div className="breadcrumbs"><span>Operações</span><ChevronRight size={14}/><strong>{pageTitle}</strong></div>
        <div className={'health ' + (health.isSuccess ? 'online' : '')} role="status"><span/>{health.isSuccess ? 'API operacional' : health.isPending ? 'Verificando API' : 'API indisponível'}</div>
      </header>
      <main>
        <div className="page-head">
          <div><h1>{pageTitle}</h1><p>{page === 'overview' ? 'Acompanhe o saldo e as movimentações da sua carteira.' :
            page === 'ledger' ? 'Confira os créditos e débitos registrados na carteira.' : 'Consulte o estado e o resultado de uma transação.'}</p></div>
          <div className="actions"><button className="button secondary" onClick={() => showModal('wallet')}><Plus size={16}/> Nova carteira</button>
            <button className="button primary" disabled={!wallet} onClick={() => showModal('wager')}><ArrowLeftRight size={16}/> Nova transação</button></div>
        </div>
        <section className="wallet-strip" aria-label="Carteira ativa">
          <div className="wallet-symbol"><WalletIcon size={21}/></div>
          <div className="wallet-name"><strong>Carteira ativa</strong><span className={wallet ? 'mono' : ''}>{wallet ? shortId(wallet.id) : walletQuery.isFetching ? 'Carregando carteira…' : 'Nenhuma carteira selecionada'}</span></div>
          {wallet && <button className="icon-button copy" title={copied ? 'ID copiado' : 'Copiar ID da carteira'} aria-label={copied ? 'ID copiado' : 'Copiar ID da carteira'} onClick={() => void copyWallet()}>{copied ? <BadgeCheck size={16}/> : <Copy size={15}/>}</button>}
          <button className="button secondary small change-wallet" onClick={() => showModal('open')}>{wallet ? 'Trocar carteira' : 'Abrir carteira'}<ChevronRight size={15}/></button>
        </section>
        {walletQuery.error && <Notice error>{walletQuery.error.message}</Notice>}
        {health.error && <Notice error>{health.error.message}</Notice>}
        {page === 'transactions' ? <section className="card transaction-card">
          <div className="card-heading"><div><h2>Buscar transação</h2><p>Use o ID interno ou a identificação do provedor.</p></div><Search size={20}/></div>
          <form className="form" onSubmit={event => {
            event.preventDefault();
            const data = new FormData(event.currentTarget), id = encodeURIComponent(String(data.get('transaction')).trim());
            setLookup(lookupMode === 'provider' ? '/providers/' + encodeURIComponent(String(data.get('provider')).trim()) + '/wagering/transactions/' + id : '/wagering/transactions/' + id);
          }}>
            <label className="field">Tipo de consulta<select value={lookupMode} onChange={event => setLookupMode(event.target.value as 'internal' | 'provider')}>
              <option value="internal">ID interno</option><option value="provider">Provedor e ID externo</option>
            </select></label>
            {lookupMode === 'provider' && <Field name="provider" label="Provedor"/>}
            <Field name="transaction" label={lookupMode === 'internal' ? 'ID da transação' : 'ID externo'}/>
            <button className="button primary"><Search size={16}/> Consultar</button>
          </form>
          {details.error && <Notice error>{details.error.message}</Notice>}
          {details.isFetching && !details.data && <Notice>Consultando transação…</Notice>}
          {details.data && <TransactionResult transaction={details.data}/>}
        </section> : wallet ? <>
          {page === 'overview' && <div className="metrics">
            <section className="card balance"><div className="metric-label"><WalletIcon size={17}/> Saldo atual</div><div className="metric-value mono">{formatMoney(wallet.balance)}</div><span>Saldo registrado na carteira</span></section>
            <section className="card metric"><div className="metric-label"><Database size={17}/> Versão da carteira</div><div className="metric-value mono">{wallet.version}</div><span>Atualizada a cada mudança de saldo</span></section>
            <section className="card metric"><div className="metric-label"><Activity size={17}/> Moeda</div><div className="metric-value mono">{wallet.balance.currency}</div><span>{wallet.balance.currency === 'BRL' ? 'Real brasileiro' : 'Moeda da carteira'}</span></section>
          </div>}
          <div className={page === 'overview' ? 'workspace' : ''}>
            <LedgerPanel rows={rows} loading={ledger.isFetching} error={ledger.error} expand={() => setPage('ledger')}
              isExpanded={page === 'ledger'} onTransaction={inspect} next={ledger.hasNextPage ? () => void ledger.fetchNextPage() : undefined}/>
            {page === 'overview' && <section className="card reconciliation">
              <div className="recon-icon"><ClipboardCheck size={21}/></div><h2>Reconciliação</h2>
              <p>Compare o saldo registrado com a soma dos lançamentos desta carteira.</p>
              <button className="button secondary" disabled={reconcile.isPending} onClick={() => reconcile.mutate(wallet.id)}><RefreshCw size={15}/>{reconcile.isPending ? 'Conferindo…' : 'Conferir saldo'}</button>
              {reconcile.error && <Notice error>{reconcile.error.message}</Notice>}
              {reconcile.data && <div className="result" role="status"><span className={'pill ' + (reconcile.data.consistent ? 'success' : 'danger')}><span/>{reconcile.data.consistent ? 'Saldo consistente' : 'Divergência detectada'}</span>
                <dl><dt>Registrado</dt><dd className="mono">{formatMoney(reconcile.data.storedBalance)}</dd>
                  <dt>Calculado</dt><dd className="mono">{formatMoney(reconcile.data.calculatedBalance)}</dd>
                  <dt>Diferença</dt><dd className="mono">{formatMoney(reconcile.data.difference)}</dd><dt>Lançamentos</dt><dd className="mono">{reconcile.data.checkedEntries}</dd></dl></div>}
              <div className="recon-note"><CircleHelp size={14}/> A conferência não altera o saldo.</div>
            </section>}
          </div>
        </> : <section className="card empty no-wallet"><WalletIcon size={28}/><h2>Selecione uma carteira</h2><p>Abra uma carteira existente ou crie uma para testar o sistema.</p>
          <button className="button primary" onClick={() => showModal('wallet')}><Plus size={16}/> Nova carteira</button></section>}
      </main>
    </div>
    {modal === 'wallet' && <ModalForm title="Nova carteira" description="Crie uma carteira de teste para um jogador." close={() => setModal(null)}>
      <form className="form" onSubmit={event => {
        event.preventDefault(); const form = new FormData(event.currentTarget);
        createWallet.mutate({ playerId: String(form.get('player')).trim(), initialBalance: { amount: String(form.get('amount')).trim().replace(',', '.'), currency: String(form.get('currency')).trim().toUpperCase() } });
      }}>
        <Field name="player" label="ID do jogador" initial={newPlayerId} />
        <div className="form-grid"><Field name="amount" label="Saldo inicial" initial="100.00"/><Field name="currency" label="Moeda" initial="BRL"/></div>
        {createWallet.error && <Notice error>{createWallet.error.message}</Notice>}
        <button className="button primary" disabled={createWallet.isPending}>{createWallet.isPending ? 'Criando…' : 'Criar carteira'}</button>
      </form>
    </ModalForm>}
    {modal === 'open' && <ModalForm title="Abrir carteira" description="Informe o ID completo da carteira." close={() => setModal(null)}>
      <form className="form" onSubmit={event => { event.preventDefault(); openWallet.mutate(String(new FormData(event.currentTarget).get('wallet')).trim()); }}>
        <Field name="wallet" label="ID da carteira" initial={wallet?.id} />
        {openWallet.error && <Notice error>{openWallet.error.message}</Notice>}
        <button className="button primary" disabled={openWallet.isPending}>{openWallet.isPending ? 'Abrindo…' : 'Abrir carteira'}</button>
      </form>
    </ModalForm>}
    {modal === 'wager' && wallet && <ModalForm title="Nova transação" description={'Carteira ' + shortId(wallet.id)} close={() => setModal(null)}>
      <WagerForm wallet={wallet} submit={(wager, key) => send.mutate({wager, key})} busy={send.isPending} error={send.error} result={submitted}/>
    </ModalForm>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
