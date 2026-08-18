<#macro emailLayout>
<!doctype html>
<html lang="${locale.language}" dir="${(ltr)?then('ltr','rtl')}">
<body style="margin:0;padding:0;background:#123f53;font-family:Arial,Helvetica,sans-serif;color:#102239;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#123f53;padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;">
          <tr>
            <td style="padding:0 8px 22px;text-align:center;color:#22bec7;font-size:34px;font-weight:700;letter-spacing:1px;">
              ngenious
            </td>
          </tr>
          <tr>
            <td style="background:#ffffff;border-top:5px solid #22bec7;border-radius:18px;padding:42px 40px;">
              <#nested>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 18px 0;text-align:center;color:#d5e3e8;font-size:13px;line-height:20px;">
              Need help? Contact
              <a href="mailto:support@ngenious.ai" style="color:#6ee7eb;text-decoration:none;">support@ngenious.ai</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
</#macro>

