import { useState, useRef, useImperativeHandle, forwardRef } from 'react'
import { useTranslation } from 'react-i18next'

export interface CertificatePickerHandle {
  file: () => Promise<string>
}

export const CertificatePicker = forwardRef<CertificatePickerHandle>(
  function CertificatePicker (_props, ref) {
    const { t } = useTranslation()
    const fileInputRef = useRef<HTMLInputElement>(null)
    const [selectedName, setSelectedName] = useState('')
    const [hasFile, setHasFile] = useState(false)

    useImperativeHandle(ref, () => ({
      file: async () => {
        const input = fileInputRef.current
        if (!input || !input.value || !input.files || !input.files.length) {
          return ''
        }
        return await input.files[0].text()
      },
    }))

    const handleFileChange = () => {
      const input = fileInputRef.current
      if (!input || !input.files || !input.files.length) return
      setSelectedName(input.files[0].name)
      setHasFile(true)
    }

    const clearFile = () => {
      const input = fileInputRef.current
      if (input) input.value = ''
      setSelectedName('')
      setHasFile(false)
    }

    const triggerFileSelect = () => {
      fileInputRef.current?.click()
    }

    return (
      <div className="d-flex align-items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          className="d-none"
          onChange={handleFileChange}
        />
        <span className="fs15">
          {hasFile ? selectedName : t('NONE_SELECTED')}
        </span>
        {hasFile
? (
          <button className="btn btn-sm btn-danger" onClick={clearFile}>
            {t('Remove')}
          </button>
        )
: (
          <button className="btn btn-sm btn-primary" onClick={triggerFileSelect}>
            {t('TLS_CERTIFICATE')}
          </button>
        )}
      </div>
    )
  }
)
