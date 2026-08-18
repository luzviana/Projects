<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
  <#if section = "header">
    <#if requiredActions??>
      Finish setting up your account
    <#elseif messageHeader??>
      ${kcSanitize(msg("${messageHeader}"))?no_esc}
    <#else>
      ${message.summary}
    </#if>
  <#elseif section = "form">
    <div id="kc-info-message">
      <#if requiredActions??>
        <p class="instruction ngenious-setup-instruction">Confirm your email address and create a password to access ngenious.</p>
        <#if actionUri?has_content>
          <a id="ngenious-continue-setup" class="pf-v5-c-button pf-m-primary pf-m-block" href="${actionUri}">Continue</a>
        </#if>
      <#else>
        <p class="instruction">${message.summary}</p>
        <#if skipLink??>
        <#elseif pageRedirectUri?has_content>
          <p><a href="${pageRedirectUri}">${msg("backToApplication")}</a></p>
        <#elseif actionUri?has_content>
          <p><a href="${actionUri}">${msg("proceedWithAction")}</a></p>
        <#elseif (client.baseUrl)?has_content>
          <p><a href="${client.baseUrl}">${msg("backToApplication")}</a></p>
        </#if>
      </#if>
    </div>
  </#if>
</@layout.registrationLayout>
