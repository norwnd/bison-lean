// BridgeDetails - per-tx details popup (B-L16).
//
// Direct port of vanilla
// `client/webserver/site/src/js/bridging/components/BridgeDetails.tsx`.
// Replaces `app()` with `useAuthStore`, `intl.prep` with
// `useTranslation`, `Doc.formatCoinValueAtom` with the local helper from
// hooks/useFormatters, and the inline copy-button widget with the
// shared CopyButton component (`components/common/CopyButton.tsx`).

import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../stores/useAuthStore'
import { formatCoinAtom, logoPath } from '../../hooks/useFormatters'
import { CopyButton } from '../common/CopyButton'
import {
  bridgeDisplayName, bridgeLogoPath, formatDateTime, getFeeAsset,
  networkInfo, trimStringWithEllipsis
} from './bridgeUtils'
import type { BridgeTransaction } from './bridgeData'

interface BridgeDetailsProps {
  tx: BridgeTransaction
}

function BridgeDetails ({ tx }: BridgeDetailsProps) {
  const { t } = useTranslation()
  const assets = useAuthStore(s => s.assets)

  const sourceAsset = assets[tx.sourceAssetID]
  const destAssetID = tx.bridgeCounterpartTx?.assetID
  const destAsset = destAssetID !== undefined ? assets[destAssetID] : null
  const counterpart = tx.bridgeCounterpartTx

  const getStatusBadge = () => {
    if (counterpart?.complete) {
      return <span className="badge bg-success">{t('COMPLETE')}</span>
    }
    return <span className="badge bg-warning">{t('PENDING')}</span>
  }

  return (
    <div className="flex-stretch-column" style={{ minWidth: '425px' }}>
      <header>{t('BRIDGE_DETAILS')}</header>

      <table className="compact w-100">
        <tbody>
          {/* Status */}
          <tr>
            <td className="grey">{t('Status')}</td>
            <td>{getStatusBadge()}</td>
          </tr>

          {/* Bridge */}
          {tx.bridgeName && (
            <tr>
              <td className="grey">{t('BRIDGE')}</td>
              <td>
                <div>
                  <img
                    src={bridgeLogoPath(tx.bridgeName)}
                    className="micro-icon me-1"
                    alt=""
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                  <span>{bridgeDisplayName(tx.bridgeName, 'long')}</span>
                </div>
              </td>
            </tr>
          )}

          {/* Direction */}
          <tr>
            <td className="grey">{t('Direction')}</td>
            <td>
              <div>
                {sourceAsset && (
                  <>
                    <img
                      src={logoPath(networkInfo(tx.sourceAssetID, assets).symbol)}
                      className="micro-icon me-1"
                      alt=""
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                    <span>{networkInfo(tx.sourceAssetID, assets).name}</span>
                  </>
                )}
                <span className="mx-2">&rarr;</span>
                {destAsset && destAssetID !== undefined && (
                  <>
                    <img
                      src={logoPath(networkInfo(destAssetID, assets).symbol)}
                      className="micro-icon me-1"
                      alt=""
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                    <span>{networkInfo(destAssetID, assets).name}</span>
                  </>
                )}
              </div>
            </td>
          </tr>

          {/* Amount sent */}
          <tr>
            <td className="grey">{t('AMOUNT_SENT')}</td>
            <td>
              {sourceAsset
                ? `${formatCoinAtom(tx.amount, sourceAsset.unitInfo)} ${sourceAsset.unitInfo.conventional.unit}`
                : String(tx.amount)}
            </td>
          </tr>

          {/* Amount received */}
          {counterpart && counterpart.amountReceived > 0 && destAssetID !== undefined && (
            <tr>
              <td className="grey">{t('AMOUNT_RECEIVED')}</td>
              <td className="text-success">
                {destAsset
                  ? `${formatCoinAtom(counterpart.amountReceived, destAsset.unitInfo)} ${destAsset.unitInfo.conventional.unit}`
                  : String(counterpart.amountReceived)}
              </td>
            </tr>
          )}

          {/* Bridge Fee (difference between amount sent and received) */}
          {counterpart && counterpart.amountReceived > 0 && tx.amount > counterpart.amountReceived && destAsset && (
            <tr>
              <td className="grey">{t('BRIDGE_FEE')}</td>
              <td>
                {`${formatCoinAtom(tx.amount - counterpart.amountReceived, destAsset.unitInfo)} ${destAsset.unitInfo.conventional.unit}`}
              </td>
            </tr>
          )}

          {/* Source Gas Fee */}
          {tx.fees > 0 && (() => {
            const feeAsset = getFeeAsset(tx.sourceAssetID, assets)
            return (
              <tr>
                <td className="grey">{t('SOURCE_FEE')}</td>
                <td>
                  {feeAsset
                    ? `${formatCoinAtom(tx.fees, feeAsset.unitInfo)} ${feeAsset.unitInfo.conventional.unit}`
                    : String(tx.fees)}
                </td>
              </tr>
            )
          })()}

          {/* Destination Gas Fee (if available) */}
          {counterpart && counterpart.fees > 0 && destAssetID !== undefined && (() => {
            const feeAsset = getFeeAsset(destAssetID, assets)
            return (
              <tr>
                <td className="grey">{t('DEST_FEE')}</td>
                <td>
                  {feeAsset
                    ? `${formatCoinAtom(counterpart.fees, feeAsset.unitInfo)} ${feeAsset.unitInfo.conventional.unit}`
                    : String(counterpart.fees)}
                </td>
              </tr>
            )
          })()}

          {/* Timestamp */}
          <tr>
            <td className="grey">{t('Timestamp')}</td>
            <td>{formatDateTime(tx.timestamp)}</td>
          </tr>

          {/* Transaction ID */}
          <tr>
            <td className="grey">{t('TX_ID')}</td>
            <td>
              <span className="d-inline-flex align-items-center gap-1">
                <span className="mono" title={tx.id}>{trimStringWithEllipsis(tx.id, 20)}</span>
                <CopyButton text={tx.id} />
              </span>
            </td>
          </tr>

          {/* Counterpart TX IDs */}
          {counterpart && counterpart.ids && counterpart.ids.length > 0 && (
            <>
              {counterpart.ids.map((id, i) => (
                <tr key={i}>
                  <td className="grey">{i === 0 ? t('DEST_TX') : ''}</td>
                  <td>
                    <span className="d-inline-flex align-items-center gap-1">
                      <span className="mono" title={id}>{trimStringWithEllipsis(id, 20)}</span>
                      <CopyButton text={id} />
                    </span>
                  </td>
                </tr>
              ))}
            </>
          )}
        </tbody>
      </table>
    </div>
  )
}

export default BridgeDetails
