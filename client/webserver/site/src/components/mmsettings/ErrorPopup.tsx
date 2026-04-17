// Error popup ported from vanilla
// `mmsettings/components/ErrorPopup.tsx`.
//
// Consumes `MMSettingsSetErrorContext` (set by the MMSettings shell in
// batch 9) and renders the shared `Popup` primitive with danger styling.
// Closing the popup clears the context error and optionally runs the
// caller-supplied `onClose`.

import React, { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { MMSettingsSetErrorContext, MMSettingsError } from './MMSettings'
import Popup from './Popup'

interface ErrorPopupProps {
  error: MMSettingsError | null
}

const ErrorPopup: React.FC<ErrorPopupProps> = ({ error }) => {
  const setError = useContext(MMSettingsSetErrorContext)
  const { t } = useTranslation()

  if (!error || !setError) {
    return null
  }

  const handleClose = () => {
    setError(null)
    if (error.onClose) {
      error.onClose()
    }
  }

  return (
    <Popup
      title={t('MM_ERROR')}
      message={error.message}
      messageClass="text-danger"
      buttons={[
        { text: t('MM_CLOSE'), onClick: handleClose }
      ]}
      onClose={handleClose}
    />
  )
}

export default ErrorPopup
