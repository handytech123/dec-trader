$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Security

$form = [System.Windows.Forms.Form]::new()
$form.Text = "CFIE - Secure CoinGlass API Key"
$form.StartPosition = "CenterScreen"
$form.Size = [System.Drawing.Size]::new(560, 205)
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

$label = [System.Windows.Forms.Label]::new()
$label.Text = "Paste the CoinGlass API key. It will be encrypted for this Windows user and kept outside Git."
$label.Location = [System.Drawing.Point]::new(18, 18)
$label.Size = [System.Drawing.Size]::new(510, 38)
$form.Controls.Add($label)

$keyBox = [System.Windows.Forms.TextBox]::new()
$keyBox.Location = [System.Drawing.Point]::new(20, 62)
$keyBox.Size = [System.Drawing.Size]::new(505, 25)
$keyBox.UseSystemPasswordChar = $true
$form.Controls.Add($keyBox)

$status = [System.Windows.Forms.Label]::new()
$status.Location = [System.Drawing.Point]::new(20, 96)
$status.Size = [System.Drawing.Size]::new(390, 38)
$form.Controls.Add($status)

$save = [System.Windows.Forms.Button]::new()
$save.Text = "Encrypt and save"
$save.Location = [System.Drawing.Point]::new(405, 96)
$save.Size = [System.Drawing.Size]::new(120, 32)
$form.Controls.Add($save)
$form.AcceptButton = $save

$save.Add_Click({
  if ([string]::IsNullOrWhiteSpace($keyBox.Text)) {
    $status.Text = "The key cannot be empty."
    return
  }
  try {
    $secretDirectory = Join-Path $env:LOCALAPPDATA "CFIE"
    $secretPath = Join-Path $secretDirectory "coinglass-api-key.dpapi"
    [System.IO.Directory]::CreateDirectory($secretDirectory) | Out-Null
    $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($keyBox.Text)
    $entropy = [System.Text.Encoding]::UTF8.GetBytes("CFIE:COINGLASS:API_KEY:V1")
    try {
      $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
        $plainBytes,
        $entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      Set-Content -LiteralPath $secretPath -Value ([Convert]::ToBase64String($protectedBytes)) `
        -Encoding ascii -NoNewline
    } finally {
      [Array]::Clear($plainBytes, 0, $plainBytes.Length)
      if ($null -ne $protectedBytes) {
        [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
      }
    }
    $keyBox.Clear()
    $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Close()
  } catch {
    $keyBox.Clear()
    $message = $_.Exception.Message
    $status.Text = "Unable to encrypt: $message"
    Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA "CFIE\coinglass-key-setup-error.log") `
      -Value $message -Encoding utf8
  }
})

$form.Add_Shown({ $keyBox.Focus() })
$result = $form.ShowDialog()
if ($result -ne [System.Windows.Forms.DialogResult]::OK) { exit 1 }
