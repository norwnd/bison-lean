import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useMarketPageContext } from './MarketPageContext'

// ---------------------------------------------------------------------------
// StatusPanels -- pure presentation for the 5-way conditional status block
// (MP-29..MP-32 + the notRegistered / viewOnly case). Receives the pre-
// computed `statusPanel` descriptor and renders the appropriate panel.
// ---------------------------------------------------------------------------

export interface StatusPanelData {
  kind: 'none' | 'notRegistered' | 'penaltyCompsRequired' | 'registrationStatus' | 'bondCreationPending' | 'bondRequired'
  penalties?: number
  penaltyComps?: number
  regStatusTitle?: string
  regStatusConfs?: string
  effectiveTier?: number
}

export interface StatusPanelsProps {
  statusPanel: StatusPanelData
  loaderMsgText: string
  noWalletMsg: string
}

export function StatusPanels ({ statusPanel, loaderMsgText, noWalletMsg }: StatusPanelsProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { selected } = useMarketPageContext()

  return (
    <>
      {/* MP-28: Unsupported-asset-version loader message. */}
      {loaderMsgText && (
        <div className="fs15 pt-3 text-center">{loaderMsgText}</div>
      )}

      {/* Not registered notice (viewOnly DEX). Gated on loaderMsgText per vanilla. */}
      {!loaderMsgText && statusPanel.kind === 'notRegistered' && (
        <div>
          <div className="p-3 flex-center fs17 grey">{t('create_account_to_trade')}</div>
          <div className="border-top border-bottom flex-center p-2">
            <p className="text-center fs14 p-2 m-0">{t('need_to_register_msg', { host: selected.host })}</p>
            <button
              type="button"
              className="text-nowrap"
              onClick={() => navigate(`/register?host=${encodeURIComponent(selected.host)}`)}
            >
              {t('Create Account')}
            </button>
          </div>
        </div>
      )}

      {/* MP-29: Bond creation pending -- posting bonds shortly. */}
      {statusPanel.kind === 'bondCreationPending' && (
        <div className="p-2 mt-2">
          <div className="p-0 w-100">
            <div className="d-flex flex-column justify-content-center align-items-center">
              <p className="title">{t('posting_bonds_shortly')}</p>
              <p>{t('bond_creation_pending_msg', { host: selected.host })}</p>
            </div>
          </div>
        </div>
      )}

      {/* MP-30: Registration status -- waiting for bond confirmations. */}
      {statusPanel.kind === 'registrationStatus' && (
        <div className="p-2 mt-2 waiting">
          <div className="p-0 w-100">
            <div className="d-flex flex-column justify-content-center align-items-center">
              <span className="title">{statusPanel.regStatusTitle}</span>
              <p>{t('reg_status_msg', { host: selected.host })}</p>
              <span>{statusPanel.regStatusConfs}</span>
            </div>
          </div>
        </div>
      )}

      {/* MP-31: Penalty-comps required to trade. */}
      {statusPanel.kind === 'penaltyCompsRequired' && (
        <div className="p-2 mt-2">
          <div className="p-3 flex-center fs16 grey">{t('action_required_to_trade')}</div>
          <div className="border-top border-bottom flex-center p-2">
            <p className="text-center fs14 p-2 m-0">
              {t('set_penalty_comps', {
                penalties: statusPanel.penalties ?? 0,
                penaltyComps: statusPanel.penaltyComps ?? 0,
              })}{' '}
              <a
                className="fs15 hoverbg subtlelink pointer"
                onClick={() => navigate(`/dexsettings/${encodeURIComponent(selected.host)}`)}
              >
                {t('update_penalty_comps')}
              </a>
            </p>
          </div>
        </div>
      )}

      {/* MP-32: Bond required -- tier 0, no target tier set. */}
      {statusPanel.kind === 'bondRequired' && (
        <div className="p-2 mt-2">
          <div className="p-3 flex-center fs17 grey">{t('action_required_to_trade')}</div>
          <div className="border-top border-bottom flex-center p-2">
            <p className="text-center fs16 p-2 m-0">
              {t('acct_tier_post_bond', { tier: statusPanel.effectiveTier ?? 0 })}{' '}
              <a
                className="fs16 hoverbg subtlelink pointer"
                onClick={() => navigate(`/dexsettings/${encodeURIComponent(selected.host)}`)}
              >
                {t('enable_bond_maintenance')}
              </a>
            </p>
          </div>
        </div>
      )}

      {/* MP-33: No-wallet CTA (missing / disabled / not-running) */}
      {!loaderMsgText && noWalletMsg && (
        <div className="p-3 border-bottom flex-center fs17 grey">{noWalletMsg}</div>
      )}
    </>
  )
}
