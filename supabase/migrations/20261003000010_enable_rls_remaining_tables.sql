-- Enable RLS on the 20 public tables earlier migrations created without it.
-- Without RLS these were readable/writable by anyone holding the public anon
-- key through PostgREST. The service role bypasses RLS, so server routes are
-- unaffected; reference tables keep read access for signed-in users.
do $$
declare t text;
begin
  foreach t in array array[
    'trailing_stops','trading_signals_v2','trading_rules','broker_connections',
    'risk_rules','ml_models','backtest_results','trade_history',
    'leaderboard_snapshots','tax_federal_brackets','tax_state_rules',
    'tax_contribution_limits','tax_strategies','tax_audit_log','rate_limits',
    'rate_limit_usage','user_quotas','metrics_data','merchants',
    'merchant_detection_patterns'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;

  foreach t in array array[
    'tax_federal_brackets','tax_state_rules','tax_contribution_limits',
    'tax_strategies','merchants','merchant_detection_patterns'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists "read reference data" on public.%I', t);
      execute format(
        'create policy "read reference data" on public.%I for select to authenticated using (true)', t);
    end if;
  end loop;
end $$;
