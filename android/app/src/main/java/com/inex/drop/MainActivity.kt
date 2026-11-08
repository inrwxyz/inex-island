package com.inex.drop

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.widget.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okio.BufferedSink
import okio.source
import org.json.JSONObject
import java.io.IOException
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

class MainActivity : AppCompatActivity() {

    private lateinit var tvStatusBadge: TextView
    private lateinit var layoutConnectCard: LinearLayout
    private lateinit var layoutConnectedPanel: LinearLayout
    private lateinit var etHost: EditText
    private lateinit var etPin: EditText
    private lateinit var btnScanQR: Button
    private lateinit var btnManualConnect: Button
    private lateinit var btnPickFiles: Button
    private lateinit var btnDisconnect: Button

    private lateinit var layoutProgress: LinearLayout
    private lateinit var tvProgressTitle: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var tvProgressSpeed: TextView

    private lateinit var layoutIncomingBox: LinearLayout
    private lateinit var layoutIncomingItems: LinearLayout

    private var currentHost: String = ""
    private var currentPin: String = ""
    private var isConnected: Boolean = false
    private var pollingActive: Boolean = false

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    // 1. QR Code Scanner Launcher
    private val qrScanLauncher = registerForActivityResult(ScanContract()) { result ->
        if (result.contents != null) {
            parseAndConnect(result.contents)
        }
    }

    // 2. Multiple File Picker Launcher
    private val filePickerLauncher = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (uris.isNotEmpty()) {
            uploadFiles(uris)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tvStatusBadge = findViewById(R.id.tvStatusBadge)
        layoutConnectCard = findViewById(R.id.layoutConnectCard)
        layoutConnectedPanel = findViewById(R.id.layoutConnectedPanel)
        etHost = findViewById(R.id.etHost)
        etPin = findViewById(R.id.etPin)
        btnScanQR = findViewById(R.id.btnScanQR)
        btnManualConnect = findViewById(R.id.btnManualConnect)
        btnPickFiles = findViewById(R.id.btnPickFiles)
        btnDisconnect = findViewById(R.id.btnDisconnect)

        layoutProgress = findViewById(R.id.layoutProgress)
        tvProgressTitle = findViewById(R.id.tvProgressTitle)
        progressBar = findViewById(R.id.progressBar)
        tvProgressSpeed = findViewById(R.id.tvProgressSpeed)

        layoutIncomingBox = findViewById(R.id.layoutIncomingBox)
        layoutIncomingItems = findViewById(R.id.layoutIncomingItems)

        val prefs = getSharedPreferences("inex_drop_prefs", Context.MODE_PRIVATE)
        currentHost = prefs.getString("last_host", "") ?: ""
        currentPin = prefs.getString("last_pin", "") ?: ""
        if (currentHost.isNotEmpty()) etHost.setText(currentHost)
        if (currentPin.isNotEmpty()) etPin.setText(currentPin)

        btnScanQR.setOnClickListener {
            val options = ScanOptions().apply {
                setPrompt("Point camera at Inex Island QR code on PC")
                setBeepEnabled(false)
                setOrientationLocked(false)
            }
            qrScanLauncher.launch(options)
        }

        btnManualConnect.setOnClickListener {
            val host = etHost.text.toString().trim()
            val pin = etPin.text.toString().trim()
            if (host.isNotEmpty()) {
                connectToHost(host, pin)
            } else {
                Toast.makeText(this, "Enter PC IP and Port", Toast.LENGTH_SHORT).show()
            }
        }

        btnPickFiles.setOnClickListener {
            filePickerLauncher.launch("*/*")
        }

        btnDisconnect.setOnClickListener {
            disconnect()
        }
    }

    private fun parseAndConnect(qrData: String) {
        try {
            val url = URL(qrData)
            val host = if (url.port > 0) "${url.host}:${url.port}" else url.host
            val query = url.query ?: ""
            var pin = ""
            for (p in query.split("&")) {
                val parts = p.split("=")
                if (parts.size == 2 && parts[0] == "pin") {
                    pin = parts[1]
                }
            }
            etHost.setText(host)
            etPin.setText(pin)
            connectToHost(host, pin)
        } catch (e: Exception) {
            connectToHost(qrData, "")
        }
    }

    private fun connectToHost(host: String, pin: String) {
        val cleanHost = host.removePrefix("http://").removePrefix("https://").trimEnd('/')
        currentHost = cleanHost
        currentPin = pin

        getSharedPreferences("inex_drop_prefs", Context.MODE_PRIVATE).edit()
            .putString("last_host", cleanHost)
            .putString("last_pin", pin)
            .apply()

        val devName = "${Build.MANUFACTURER} ${Build.MODEL}"
        val bodyJson = JSONObject().apply { put("device", devName) }.toString()
        val reqBody = RequestBody.create("application/json".toMediaTypeOrNull(), bodyJson)

        val regUrl = "http://$cleanHost/register?pin=${URLEncoder.encode(pin, "UTF-8")}"
        val req = Request.Builder().url(regUrl).post(reqBody).build()

        tvStatusBadge.text = "Connecting..."

        httpClient.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                runOnUiThread {
                    tvStatusBadge.text = "Offline"
                    Toast.makeText(this@MainActivity, "Connection failed: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }

            override fun onResponse(call: Call, response: Response) {
                if (response.isSuccessful) {
                    runOnUiThread {
                        setConnectedUI(true)
                        startPolling()
                    }
                } else {
                    runOnUiThread {
                        tvStatusBadge.text = "Offline"
                        Toast.makeText(this@MainActivity, "Connection rejected by PC", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        })
    }

    private fun setConnectedUI(connected: Boolean) {
        isConnected = connected
        if (connected) {
            tvStatusBadge.text = "Connected"
            tvStatusBadge.setTextColor(ContextCompat.getColor(this, R.color.accent_green))
            tvStatusBadge.setBackgroundColor(0x3330D158)
            layoutConnectCard.visibility = View.GONE
            layoutConnectedPanel.visibility = View.VISIBLE
        } else {
            tvStatusBadge.text = "Offline"
            tvStatusBadge.setTextColor(ContextCompat.getColor(this, R.color.text_dim))
            tvStatusBadge.setBackgroundColor(0x22FFFFFF)
            layoutConnectCard.visibility = View.VISIBLE
            layoutConnectedPanel.visibility = View.GONE
            layoutProgress.visibility = View.GONE
        }
    }

    private fun startPolling() {
        pollingActive = true
        Thread {
            while (pollingActive && isConnected) {
                try {
                    val pollUrl = "http://$currentHost/files?pin=${URLEncoder.encode(currentPin, "UTF-8")}"
                    val req = Request.Builder().url(pollUrl).get().build()
                    val res = httpClient.newCall(req).execute()
                    if (res.isSuccessful) {
                        val body = res.body?.string() ?: "[]"
                        runOnUiThread { updateIncomingList(body) }
                    }
                } catch (_: Exception) {}
                Thread.sleep(3000)
            }
        }.start()
    }

    private fun updateIncomingList(jsonStr: String) {
        try {
            val arr = org.json.JSONArray(jsonStr)
            layoutIncomingItems.removeAllViews()
            if (arr.length() == 0) {
                layoutIncomingBox.visibility = View.GONE
                return
            }
            layoutIncomingBox.visibility = View.VISIBLE
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val fname = obj.getString("name")
                val fsize = obj.getLong("size")
                val mb = String.format("%.1f MB", fsize.toDouble() / (1024 * 1024))

                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    setPadding(12, 12, 12, 12)
                    setBackgroundColor(0x11FFFFFF)
                }

                val info = TextView(this).apply {
                    text = "$fname ($mb)"
                    setTextColor(ContextCompat.getColor(context, R.color.text_white))
                    textSize = 13f
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                }

                val btn = Button(this).apply {
                    text = "Save"
                    textSize = 12f
                    setBackgroundColor(ContextCompat.getColor(context, R.color.accent_blue))
                    setOnClickListener { downloadFile(fname) }
                }

                row.addView(info)
                row.addView(btn)
                layoutIncomingItems.addView(row)
            }
        } catch (_: Exception) {}
    }

    private fun downloadFile(fileName: String) {
        val dlUrl = "http://$currentHost/download/${URLEncoder.encode(fileName, "UTF-8")}?pin=${URLEncoder.encode(currentPin, "UTF-8")}"
        val request = DownloadManager.Request(Uri.parse(dlUrl)).apply {
            setTitle(fileName)
            setDescription("Downloading from Inex Island PC")
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
        }
        val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        dm.enqueue(request)
        Toast.makeText(this, "Downloading $fileName to Downloads", Toast.LENGTH_SHORT).show()
    }

    private fun uploadFiles(uris: List<Uri>) {
        Thread {
            for (uri in uris) {
                uploadSingleUri(uri)
            }
        }.start()
    }

    private fun uploadSingleUri(uri: Uri) {
        var fileName = "file.bin"
        var fileSize = 0L

        contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            val sizeIndex = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE)
            if (cursor.moveToFirst()) {
                if (nameIndex != -1) fileName = cursor.getString(nameIndex)
                if (sizeIndex != -1) fileSize = cursor.getLong(sizeIndex)
            }
        }

        runOnUiThread {
            layoutProgress.visibility = View.VISIBLE
            tvProgressTitle.text = "Prompting PC for '$fileName'..."
            progressBar.progress = 10
            tvProgressSpeed.text = "Waiting for Accept on PC..."
        }

        // 1. Send /request_transfer pre-flight to PC
        var transferId = ""
        try {
            val reqJson = JSONObject().apply {
                put("name", fileName)
                put("size", fileSize)
            }.toString()
            val reqUrl = "http://$currentHost/request_transfer?pin=${URLEncoder.encode(currentPin, "UTF-8")}"
            val promptReq = Request.Builder()
                .url(reqUrl)
                .post(RequestBody.create("application/json".toMediaTypeOrNull(), reqJson))
                .build()
            val promptRes = httpClient.newCall(promptReq).execute()
            if (promptRes.isSuccessful) {
                val json = JSONObject(promptRes.body?.string() ?: "{}")
                transferId = json.optString("id", "")
            }
        } catch (e: Exception) {
            runOnUiThread {
                Toast.makeText(this, "Could not contact PC: ${e.message}", Toast.LENGTH_SHORT).show()
                layoutProgress.visibility = View.GONE
            }
            return
        }

        // 2. Poll for Accept / Decline
        var approved = false
        val startTime = System.currentTimeMillis()
        while (System.currentTimeMillis() - startTime < 40000) {
            Thread.sleep(600)
            try {
                val checkUrl = "http://$currentHost/check_transfer?id=$transferId&pin=${URLEncoder.encode(currentPin, "UTF-8")}"
                val checkRes = httpClient.newCall(Request.Builder().url(checkUrl).get().build()).execute()
                if (checkRes.isSuccessful) {
                    val status = JSONObject(checkRes.body?.string() ?: "{}").optString("status", "")
                    if (status == "accepted") {
                        approved = true
                        break
                    } else if (status == "declined") {
                        runOnUiThread {
                            tvProgressTitle.text = "Transfer Declined by PC"
                            tvProgressSpeed.text = "Rejected"
                            progressBar.progressTintList = android.content.res.ColorStateList.valueOf(0xFFFF453A.toInt())
                        }
                        Thread.sleep(2500)
                        runOnUiThread {
                            layoutProgress.visibility = View.GONE
                            progressBar.progressTintList = android.content.res.ColorStateList.valueOf(0xFF0A84FF.toInt())
                        }
                        return
                    }
                }
            } catch (_: Exception) {}
        }

        if (!approved) {
            runOnUiThread {
                Toast.makeText(this, "Transfer timed out", Toast.LENGTH_SHORT).show()
                layoutProgress.visibility = View.GONE
            }
            return
        }

        // 3. PC Accepted! High speed stream upload
        runOnUiThread {
            tvProgressTitle.text = "Sending '$fileName' to PC"
            progressBar.progress = 0
            tvProgressSpeed.text = "Starting..."
        }

        val countingBody = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaTypeOrNull()
            override fun contentLength() = fileSize

            override fun writeTo(sink: BufferedSink) {
                contentResolver.openInputStream(uri)?.use { input ->
                    val source = input.source()
                    val buffer = okio.Buffer()
                    var totalWritten = 0L
                    var lastTime = System.currentTimeMillis()
                    var lastBytes = 0L

                    while (true) {
                        val read = source.read(buffer, 256 * 1024L) // 256 KB chunk
                        if (read == -1L) break
                        sink.write(buffer, read)
                        totalWritten += read

                        val now = System.currentTimeMillis()
                        val dt = (now - lastTime) / 1000.0
                        if (dt >= 0.2 || totalWritten == fileSize) {
                            val bytesDiff = totalWritten - lastBytes
                            val mbps = (bytesDiff / (1024.0 * 1024.0 * dt))
                            val pct = if (fileSize > 0) ((totalWritten * 100) / fileSize).toInt() else 100

                            runOnUiThread {
                                progressBar.progress = pct
                                tvProgressSpeed.text = String.format("%.1f MB/s • %d%%", mbps, pct)
                            }
                            lastTime = now
                            lastBytes = totalWritten
                        }
                    }
                }
            }
        }

        val uploadUrl = "http://$currentHost/upload?id=$transferId&name=${URLEncoder.encode(fileName, "UTF-8")}&pin=${URLEncoder.encode(currentPin, "UTF-8")}"
        val uploadReq = Request.Builder().url(uploadUrl).post(countingBody).build()

        try {
            val uploadRes = httpClient.newCall(uploadReq).execute()
            if (uploadRes.isSuccessful) {
                runOnUiThread {
                    progressBar.progress = 100
                    tvProgressTitle.text = "✓ '$fileName' Sent Successfully!"
                    tvProgressSpeed.text = "100%"
                    Toast.makeText(this, "Sent to PC!", Toast.LENGTH_SHORT).show()
                }
                Thread.sleep(1800)
                runOnUiThread { layoutProgress.visibility = View.GONE }
            }
        } catch (e: Exception) {
            runOnUiThread {
                Toast.makeText(this, "Upload error: ${e.message}", Toast.LENGTH_SHORT).show()
                layoutProgress.visibility = View.GONE
            }
        }
    }

    private fun disconnect() {
        pollingActive = false
        Thread {
            try {
                val discUrl = "http://$currentHost/disconnect?pin=${URLEncoder.encode(currentPin, "UTF-8")}"
                httpClient.newCall(Request.Builder().url(discUrl).post(RequestBody.create(null, ByteArray(0))).build()).execute()
            } catch (_: Exception) {}
        }.start()
        setConnectedUI(false)
    }

    override fun onDestroy() {
        super.onDestroy()
        pollingActive = false
    }
}
