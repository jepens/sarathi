# Phase 1 Testing Guide

## 🧪 Manual Testing Checklist

### Prerequisites
- Server running: `npm run dev`
- Browser open at: http://localhost:3000/dashboard/knowledge
- Supabase credentials configured in `.env.local`

---

## Test 1: Document Upload ✅

### Steps:
1. Navigate to http://localhost:3000/dashboard/knowledge
2. Click "Select Files" button in the upload zone
3. Select a `.txt` or `.md` file from your computer
4. Wait for upload to complete

### Expected Results:
- ✅ Toast notification: "File uploaded. Processing AI embeddings..."
- ✅ Toast notification: "Success! Processed X chunks."
- ✅ Document appears in "Your Documents" list
- ✅ Stats cards update automatically:
  - Total Documents: increases by 1
  - Vector Index: shows total chunks
  - AI Readiness: shows 100%

### Test Files:
Use the included `test_document.txt` or create your own text file.

---

## Test 2: Document List Display ✅

### Steps:
1. After uploading documents, check the "Your Documents" section

### Expected Results:
- ✅ Each document shows:
  - File name
  - Number of chunks
  - Upload date/time (Indonesian format)
- ✅ Hover over document shows delete button
- ✅ Empty state message if no documents: "No documents uploaded yet..."

---

## Test 3: Document Deletion ✅

### Steps:
1. Hover over a document in the list
2. Click the trash icon that appears
3. Confirm deletion in the browser dialog

### Expected Results:
- ✅ Confirmation dialog appears
- ✅ Toast notification: "Document deleted successfully"
- ✅ Document removed from list
- ✅ Stats update automatically (decreases)
- ✅ If last document deleted, shows empty state

---

## Test 4: Real-time Stats ✅

### Steps:
1. Observe the three stats cards at the top
2. Upload a document
3. Delete a document

### Expected Results:
- ✅ **Total Documents**: Shows unique file count
- ✅ **Vector Index**: 
  - Shows "Empty" when no documents
  - Shows "Synced" with chunk count when documents exist
- ✅ **AI Readiness**:
  - Shows 0% when no documents
  - Shows 100% when documents exist
  - Shows appropriate message

---

## Test 5: Vector Search API ✅

### Steps:
1. Upload at least one document with content
2. Use curl or Postman to test the search API:

```bash
curl -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{"query": "kopi arabica"}'
```

### Expected Results:
- ✅ Returns JSON with:
  - `query`: The search term
  - `results`: Array of matching documents
  - `count`: Number of results
- ✅ Results sorted by similarity
- ✅ Each result includes:
  - `id`: Document ID
  - `content`: Text content
  - `metadata`: File information
  - `similarity`: Similarity score (0-1)

---

## Test 6: Error Handling ✅

### Test 6a: Upload Invalid File Type
1. Try to upload a `.pdf` or `.docx` file

**Expected**: Error message (PDF support disabled)

### Test 6b: Delete Non-existent Document
1. Manually call DELETE API with invalid filename

**Expected**: 404 error with message "Document not found"

### Test 6c: Network Error
1. Stop the server
2. Try to refresh the page

**Expected**: Loading state, then error handling

---

## Test 7: UI/UX Verification ✅

### Visual Checks:
- ✅ Dark mode theme applied
- ✅ Linear aesthetic (subtle borders, clean typography)
- ✅ Hover effects on interactive elements
- ✅ Loading states (spinners) during async operations
- ✅ Smooth transitions and animations
- ✅ Responsive layout (test on different screen sizes)

### Interaction Checks:
- ✅ Drag & drop works in upload zone
- ✅ Delete button only visible on hover
- ✅ Toast notifications appear and dismiss
- ✅ Buttons disabled during loading

---

## Known Issues & Limitations

### ⚠️ PDF Support
- **Status**: Disabled
- **Reason**: Next.js compatibility issues
- **Workaround**: Only `.txt` and `.md` files supported
- **Future**: Will use external service (Unstructured.io or PDF.co)

### ⚠️ Old Data
- Documents uploaded before the metadata fix (2025-11-28 17:10) will not appear in the list
- **Solution**: Delete old data from Supabase dashboard or re-upload documents

---

## Database Verification

### Check Supabase Dashboard:
1. Go to Supabase project dashboard
2. Navigate to Table Editor > `documents`
3. Verify:
   - ✅ `content` field has text chunks
   - ✅ `metadata` field has JSON with:
     - `file_name`
     - `file_type`
     - `chunk_index`
     - `created_at`
     - `source`
   - ✅ `embedding` field has vector data (array of 1536 numbers)

---

## API Endpoints Summary

| Endpoint | Method | Purpose | Status |
|----------|--------|---------|--------|
| `/api/documents` | GET | Fetch all documents | ✅ Fixed |
| `/api/documents?fileName=X` | DELETE | Delete document | ✅ Fixed |
| `/api/ingest` | POST | Process uploaded file | ✅ Fixed |
| `/api/search` | POST | Vector similarity search | ✅ Working |

---

## Success Criteria

Phase 1 is considered complete when:
- ✅ Documents can be uploaded via UI
- ✅ Documents appear in the list with correct metadata
- ✅ Documents can be deleted
- ✅ Stats reflect real-time data
- ✅ Vector search returns relevant results
- ✅ UI follows Linear aesthetic
- ✅ No console errors in browser
- ✅ No 500 errors in API calls

---

## Next Steps (Phase 2)

After Phase 1 testing is complete:
1. Chat UI implementation
2. RAG (Retrieval Augmented Generation) logic
3. Context-aware AI responses
4. Conversation history management

---

**Last Updated**: 2025-11-28 17:15 WIB
