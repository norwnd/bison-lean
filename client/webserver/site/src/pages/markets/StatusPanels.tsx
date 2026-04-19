import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useMarketPageContext } from './MarketPageContext'

// ---------------------------------------------------------------------------
// StatusPanels -- pure presentation for the 5-way conditional status block
// (MP-29..MP-32 + the notRegistered / viewOnly case). Receives the pre-
// computed `statusPanel` descriptor and renders the appropriate panel.
// ---------------------------------------------------------------------------

// Discriminated union -- each `kind` carries exactly the fields it
// needs. Lets consumers (and the JSX below) drop optional-field
// fallbacks; the compiler narrows the payload after the `kind` check.
// Keep the variant-specific field comments close to each branch.
export type StatusPanelData =
  | { kind: 'none' }
  // `authingMsg` is the already-translated sub-state label
  // ("Connecting to DEX server..." vs "Authenticating with DEX
  // server...") chosen upstream by `deriveWarmupState` based on
  // whether the WS is connected yet.
  | { kind: 'authing', authingMsg: string }
  // `failedMsg` is the Core-side failure message surfaced from a
  // `dex_auth` note with topic DexAuthError*.
  | { kind: 'authFailed', failedMsg: string }
  | { kind: 'notRegistered' }
  | { kind: 'penaltyCompsRequired', penalties: number, penaltyComps: number }
  | { kind: 'registrationStatus', regStatusTitle: string, regStatusConfs: string }
  | { kind: 'bondCreationPending' }
  | { kind: 'bondRequired', effectiveTier: number }

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

      {/* UI-AUTH: DEX connection / auth in progress. Shown while Core's
          background authDEX goroutine is still running (connected but
          !authed && !viewOnly). Replaces the misleading "Create account"
          messaging that used to appear in this window because auth.tier
          is 0 until auth completes. The specific label
          ("Connecting..." vs "Authenticating...") is picked upstream
          by `deriveWarmupState` based on whether the WS is connected
          yet -- `authingMsg` is always populated for this kind. */}
      {!loaderMsgText && statusPanel.kind === 'authing' && (
        <div className="p-3 flex-center fs17 grey">
          <div className="ico-spinner spinner fs20 me-2"></div>
          <span>{statusPanel.authingMsg}</span>
        </div>
      )}

      {/* UI-AUTH: DEX auth failed (bad password, bond wallet, etc.).
          Guard the sub-message on truthiness in case Core ever emits
          a DexAuthError* note with an empty detail string -- we'd
          otherwise render an empty grey div. */}
      {!loaderMsgText && statusPanel.kind === 'authFailed' && (
        <div className="p-3 flex-center flex-column fs16 text-danger text-center">
          <span className="ico-cross fs20 mb-1"></span>
          <div>{t('DEX_AUTH_FAILED')}</div>
          {statusPanel.failedMsg && (
            <div className="fs13 mt-1 grey">{statusPanel.failedMsg}</div>
          )}
        </div>
      )}

      {/* Not registered notice (viewOnly DEX). Gated on loaderMsgText per vanilla. */}
      {!loaderMsgText && statusPanel.kind === 'notRegistered' && (
        <div>
          <div className="p-3 flex-center fs17 grey">{t('CREATE_ACCOUNT_TO_TRADE')}</div>
          <div className="border-top border-bottom flex-center p-2">
            <p className="text-center fs14 p-2 m-0">{t('NEED_TO_REGISTER_MSG', { host: selected.host })}</p>
            <button
              type="button"
              className="text-nowrap"
              onClick={() => navigate(`/register?host=${encodeURIComponent(selected.host)}`)}
            >
              {t('CREATE_ACCOUNT')}
            </button>
          </div>
        </div>
      )}

      {/* MP-29: Bond creation pending -- posting bonds shortly. */}
      {statusPanel.kind === 'bondCreationPending' && (
        <div className="p-2 mt-2">
          <div className="p-0 w-100">
            <div className="d-flex flex-column justify-content-center align-items-center">
              <p className="title">{t('POSTING_BONDS_SHORTLY')}</p>
              <p>{t('BOND_CREATION_PENDING_MSG', { host: selected.host })}</p>
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
              <p>{t('REG_STATUS_MSG', { host: selected.host })}</p>
              <span>{statusPanel.regStatusConfs}</span>
            </div>
          </div>
        </div>
      )}

      {/* MP-31: Penalty-comps required to trade. */}
      {statusPanel.kind === 'penaltyCompsRequired' && (
        <div className="p-2 mt-2">
          <div className="p-3 flex-center fs16 grey">{t('ACTION_REQUIRED_TO_TRADE')}</div>
          <div className="border-top border-bottom flex-center p-2">
            <p className="text-center fs14 p-2 m-0">
              {t('SET_PENALTY_COMPS', {
                penalties: statusPanel.penalties,
                penaltyComps: statusPanel.penaltyComps,
              })}{' '}
              <a
                className="fs15 hoverbg subtlelink pointer"
                onClick={() => navigate(`/dexsettings/${encodeURIComponent(selected.host)}`)}
              >
                {t('UPDATE_PENALTY_COMPS')}
              </a>
            </p>
          </div>
        </div>
      )}

      {/* MP-32: Bond required -- tier 0, no target tier set. */}
      {statusPanel.kind === 'bondRequired' && (
        <div className="p-2 mt-2">
          <div className="p-3 flex-center fs17 grey">{t('ACTION_REQUIRED_TO_TRADE')}</div>
          <div className="border-top border-bottom flex-center p-2">
            <p className="text-center fs16 p-2 m-0">
              {t('ACCT_TIER_POST_BOND', { tier: statusPanel.effectiveTier })}{' '}
              <a
                className="fs16 hoverbg subtlelink pointer"
                onClick={() => navigate(`/dexsettings/${encodeURIComponent(selected.host)}`)}
              >
                {t('ENABLE_BOND_MAINTENANCE')}
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
