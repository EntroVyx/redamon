/**
 * Read a RoE upload out of a multipart request, limits first.
 *
 * The Content-Length check runs BEFORE `request.formData()`: past Next's 10 MB
 * proxy cap the body arrives truncated rather than refused, so parsing first
 * would report a size problem as a corrupt file. A request without the header
 * (chunked) is read and then held to the same file cap.
 */
import { NextRequest, NextResponse } from 'next/server'

import {
  ALLOWED_EXTENSIONS_LABEL,
  MAX_FILE_SIZE,
  MAX_REQUEST_BYTES,
  classifyRoeFile,
  type RoeFileKind,
} from './limits'

export interface RoeUpload {
  formData: FormData
  file: File
  kind: RoeFileKind
  bytes: Buffer
}

const tooLarge = () =>
  NextResponse.json(
    { error: `The file is larger than ${MAX_FILE_SIZE / 1024 / 1024} MB.`, code: 'file_too_large' },
    { status: 413 },
  )

/** 413 when the declared body is over the cap, otherwise null. */
export function contentLengthProblem(request: NextRequest): NextResponse | null {
  const raw = request.headers.get('content-length')
  if (raw === null) return null
  const length = Number(raw)
  if (!Number.isFinite(length) || length < 0) {
    return NextResponse.json({ error: 'Invalid Content-Length.' }, { status: 400 })
  }
  return length > MAX_REQUEST_BYTES ? tooLarge() : null
}

export async function readRoeUpload(
  request: NextRequest,
  fieldName = 'file',
): Promise<RoeUpload | NextResponse> {
  const lengthProblem = contentLengthProblem(request)
  if (lengthProblem) return lengthProblem

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'The upload could not be read as multipart form data.' }, { status: 400 })
  }
  const file = formData.get(fieldName)
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }
  if (file.size > MAX_FILE_SIZE) return tooLarge()
  const kind = classifyRoeFile(file.name, file.type)
  if (!kind) {
    return NextResponse.json(
      { error: `Unsupported file type. Use ${ALLOWED_EXTENSIONS_LABEL}.`, code: 'unsupported_type' },
      { status: 400 },
    )
  }
  return { formData, file, kind, bytes: Buffer.from(await file.arrayBuffer()) }
}
