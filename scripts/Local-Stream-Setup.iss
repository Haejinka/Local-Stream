#ifndef AppVersion
  #define AppVersion "0.2.4"
#endif

#ifndef ZxpSha256
  #define ZxpSha256 ""
#endif

[Setup]
AppId={{318C7A11-3C08-4C93-933B-8863F00E45C8}
AppName=Local Stream for Premiere Pro
AppVersion={#AppVersion}
AppPublisher=Local Stream Community
DefaultDirName={localappdata}\Programs\Local Stream
DefaultGroupName=Local Stream
DisableProgramGroupPage=yes
LicenseFile=..\LICENSE
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=Local-Stream-Setup-{#AppVersion}
SetupLogging=yes
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Local Stream for Premiere Pro
VersionInfoCompany=Local Stream Community
VersionInfoDescription=Local Stream setup for Adobe Premiere Pro
VersionInfoProductName=Local Stream
VersionInfoProductVersion={#AppVersion}
VersionInfoVersion={#AppVersion}.0

[Files]
Source: "..\dist\Local-Stream-{#AppVersion}.zxp"; DestDir: "{tmp}\LocalStreamWizard"; DestName: "Local-Stream.zxp"; Flags: deleteafterinstall
Source: "install-wizard.ps1"; DestDir: "{tmp}\LocalStreamWizard"; Flags: deleteafterinstall
Source: "install-cep.ps1"; DestDir: "{tmp}\LocalStreamWizard"; DestName: "install-cep.ps1"; Flags: deleteafterinstall

[UninstallDelete]
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\com.localstream.premiere"

[Messages]
WelcomeLabel2=This wizard installs the Local Stream Premiere Pro panel and prepares its media tools. Premiere Pro must be closed during setup. An internet connection is required to download any missing tools.
FinishedHeadingLabel=Local Stream is ready to use.
FinishedLabel=Open Premiere Pro, choose Window > Extensions (Legacy) > Local Stream, then enter your YouTube Data API key in Settings.

[Code]
function InitializeSetup(): Boolean;
begin
  Result := IsWin64;
  if not Result then
    MsgBox('Local Stream requires 64-bit Windows and Premiere Pro 25.6 or later with CEP 12 support.', mbError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  PowerShellPath: String;
  Parameters: String;
  HelperPath: String;
  ZxpPath: String;
  ToolSetupScriptPath: String;
  LogPath: String;
begin
  if CurStep <> ssPostInstall then
    exit;

  HelperPath := ExpandConstant('{tmp}\LocalStreamWizard\install-wizard.ps1');
  ZxpPath := ExpandConstant('{tmp}\LocalStreamWizard\Local-Stream.zxp');
  ToolSetupScriptPath := ExpandConstant('{tmp}\LocalStreamWizard\install-cep.ps1');
  LogPath := ExpandConstant('{localappdata}\Adobe\CEP\extensionsData\com.localstream.premiere\installer.log');
  PowerShellPath := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  Parameters := '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + HelperPath +
    '" -ZxpPath "' + ZxpPath + '" -ExpectedZxpSha256 "{#ZxpSha256}"' +
    ' -ToolSetupScriptPath "' + ToolSetupScriptPath + '" -LogPath "' + LogPath + '"';

  WizardForm.StatusLabel.Caption := 'Installing the signed panel and preparing required media tools...';
  WizardForm.Update;
  if not Exec(PowerShellPath, Parameters, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    MsgBox('The setup helper could not start. Restart setup and try again.', mbError, MB_OK);
    Abort;
  end;
  if ResultCode <> 0 then
  begin
    MsgBox('Setup could not finish. Close Premiere Pro if it is open, check your internet connection, and run setup again. Details are in:' + #13#10 + LogPath, mbError, MB_OK);
    Abort;
  end;
end;
