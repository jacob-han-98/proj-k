"""Confluence Storage Format → Markdown 변환기.

Confluence의 XML 기반 storage format을 파싱하여
표준 Markdown + 로컬 이미지/영상 참조로 변환한다.
"""

import re
from bs4 import BeautifulSoup, NavigableString, Tag
from markdownify import markdownify as md, MarkdownConverter


VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".wmv", ".webm", ".mkv", ".flv", ".m4v"}


def _is_video_file(filename: str) -> bool:
    """파일명이 영상 확장자인지 확인."""
    return any(filename.lower().endswith(ext) for ext in VIDEO_EXTENSIONS)


class ConfluenceMarkdownConverter(MarkdownConverter):
    """markdownify 확장: Confluence 특수 요소 처리."""

    def convert_ac_image(self, el, text, convert_as_inline):
        """ac:image → ![alt](images/filename)"""
        # ri:attachment 참조
        attachment = el.find("ri:attachment")
        if attachment:
            filename = attachment.get("ri:filename", "image.png")
            return f"![{filename}](images/{filename})"
        # ri:url 외부 이미지
        url_el = el.find("ri:url")
        if url_el:
            url = url_el.get("ri:value", "")
            return f"![image]({url})"
        return ""

    convert_ac_emoticon = lambda self, el, text, ci: ""


def _preprocess_confluence_html(html: str) -> tuple[str, list[str], list[str]]:
    """Confluence storage format을 표준 HTML에 가깝게 전처리.

    Returns:
        (전처리된 HTML, 다운로드할 이미지 파일명 리스트, 다운로드할 영상 파일명 리스트)
    """
    soup = BeautifulSoup(html, "html.parser")
    images_to_download = []
    videos_to_download = []

    # 1) ac:image → <img> 태그로 변환
    #    테이블 셀 안의 <img>는 markdownify가 alt 텍스트만 남기므로,
    #    테이블 안에서는 마크다운 이미지 문법 텍스트로 직접 치환한다.
    for img_tag in soup.find_all("ac:image"):
        attachment = img_tag.find("ri:attachment")
        url_el = img_tag.find("ri:url")
        caption_el = img_tag.find("ac:caption")

        if attachment:
            filename = attachment.get("ri:filename", "image.png")
            images_to_download.append(filename)
            src = f"images/{filename}"
            alt = caption_el.get_text().strip() if caption_el else filename
        elif url_el:
            src = url_el.get("ri:value", "")
            alt = caption_el.get_text().strip() if caption_el else "image"
        else:
            img_tag.decompose()
            continue

        # 테이블 셀 안인지 확인
        in_table = img_tag.find_parent("td") is not None or img_tag.find_parent("th") is not None

        if in_table:
            # markdownify가 테이블 셀의 <img>를 무시하므로 텍스트로 직접 삽입
            md_text = f"![{alt}]({src})"
            if caption_el:
                md_text += f" *{caption_el.get_text().strip()}*"
            replacement = NavigableString(md_text)
            img_tag.replace_with(replacement)
        else:
            new_img = soup.new_tag("img", src=src, alt=alt)
            img_tag.replace_with(new_img)
            # 캡션이 있으면 이미지 아래에 이탤릭으로 추가
            if caption_el and caption_el.get_text().strip():
                caption_p = soup.new_tag("p")
                caption_em = soup.new_tag("em")
                caption_em.string = caption_el.get_text().strip()
                caption_p.append(caption_em)
                new_img.insert_after(caption_p)

    # 2) ac:structured-macro → 적절한 HTML로 변환
    for macro in soup.find_all("ac:structured-macro"):
        macro_name = macro.get("ac:name", "")

        if macro_name == "code":
            # 코드 블록
            lang_param = macro.find("ac:parameter", attrs={"ac:name": "language"})
            lang = lang_param.string if lang_param else ""
            body = macro.find("ac:plain-text-body")
            code_text = body.string if body else ""
            # CDATA 래핑 제거
            if code_text and code_text.startswith("<![CDATA["):
                code_text = code_text[9:]
            if code_text and code_text.endswith("]]>"):
                code_text = code_text[:-3]
            pre = soup.new_tag("pre")
            code = soup.new_tag("code", attrs={"class": f"language-{lang}"} if lang else {})
            code.string = code_text or ""
            pre.append(code)
            macro.replace_with(pre)

        elif macro_name in ("multimedia", "view-file"):
            # 영상/미디어 매크로 → 영상 참조
            attachment = macro.find("ri:attachment")
            if attachment:
                filename = attachment.get("ri:filename", "media")
                if _is_video_file(filename):
                    videos_to_download.append(filename)
                    p = soup.new_tag("p")
                    p.string = f"[VIDEO: {filename}](videos/{filename})"
                    macro.replace_with(p)
                else:
                    # 비영상 파일 (PDF 등)
                    images_to_download.append(filename)
                    p = soup.new_tag("p")
                    p.string = f"[FILE: {filename}](images/{filename})"
                    macro.replace_with(p)
            else:
                macro.decompose()

        elif macro_name == "widget":
            # 외부 임베드 (YouTube 등) → URL 보존
            url_param = macro.find("ac:parameter", attrs={"ac:name": "url"})
            if url_param and url_param.string:
                url = url_param.string
                p = soup.new_tag("p")
                p.string = f"[EMBED: {url}]({url})"
                macro.replace_with(p)
            else:
                macro.decompose()

        elif macro_name in ("info", "note", "warning", "tip"):
            # 정보/경고 패널 → blockquote
            body = macro.find("ac:rich-text-body")
            prefix_map = {
                "info": "ℹ️ ",
                "note": "📝 ",
                "warning": "⚠️ ",
                "tip": "💡 ",
            }
            prefix = prefix_map.get(macro_name, "")
            if body:
                bq = soup.new_tag("blockquote")
                prefix_p = soup.new_tag("p")
                prefix_p.string = prefix
                bq.append(prefix_p)
                for child in list(body.children):
                    bq.append(child.extract())
                macro.replace_with(bq)
            else:
                macro.decompose()

        elif macro_name == "panel":
            # 패널 → blockquote
            body = macro.find("ac:rich-text-body")
            title_param = macro.find("ac:parameter", attrs={"ac:name": "title"})
            if body:
                bq = soup.new_tag("blockquote")
                if title_param and title_param.string:
                    title_p = soup.new_tag("p")
                    title_b = soup.new_tag("strong")
                    title_b.string = title_param.string
                    title_p.append(title_b)
                    bq.append(title_p)
                for child in list(body.children):
                    bq.append(child.extract())
                macro.replace_with(bq)
            else:
                macro.decompose()

        elif macro_name == "expand":
            # 확장 매크로 → details/summary 또는 그냥 포함
            title_param = macro.find("ac:parameter", attrs={"ac:name": "title"})
            title_text = title_param.string if title_param else "펼치기"
            body = macro.find("ac:rich-text-body")
            if body:
                details = soup.new_tag("details")
                summary = soup.new_tag("summary")
                summary.string = title_text
                details.append(summary)
                for child in list(body.children):
                    details.append(child.extract())
                macro.replace_with(details)
            else:
                macro.decompose()

        elif macro_name == "toc":
            # TOC 매크로 제거 (MD에서는 불필요)
            macro.decompose()

        elif macro_name == "excerpt":
            # excerpt → 내용만 추출
            body = macro.find("ac:rich-text-body")
            if body:
                macro.replace_with(body)
            else:
                macro.decompose()

        elif macro_name == "status":
            # 상태 라벨 → 인라인 텍스트
            color_param = macro.find("ac:parameter", attrs={"ac:name": "colour"})
            title_param = macro.find("ac:parameter", attrs={"ac:name": "title"})
            title = title_param.string if title_param else "STATUS"
            span = soup.new_tag("span")
            span.string = f"[{title}]"
            macro.replace_with(span)

        elif macro_name in ("children", "include", "excerpt-include",
                            "recently-updated", "livesearch", "jira"):
            # 동적 매크로 → 제거 (다운로드 시 의미 없음)
            macro.decompose()

        else:
            # 알 수 없는 매크로 → rich-text-body 내용만 추출
            body = macro.find("ac:rich-text-body")
            plain_body = macro.find("ac:plain-text-body")
            if body:
                wrapper = soup.new_tag("div")
                for child in list(body.children):
                    wrapper.append(child.extract())
                macro.replace_with(wrapper)
            elif plain_body:
                pre = soup.new_tag("pre")
                pre.string = plain_body.string or ""
                macro.replace_with(pre)
            else:
                macro.decompose()

    # 3) ac:link → <a> 태그로 변환
    for link in soup.find_all("ac:link"):
        page_ref = link.find("ri:page")
        attachment_ref = link.find("ri:attachment")
        link_body = link.find("ac:link-body") or link.find("ac:plain-text-link-body")

        if page_ref:
            page_title = page_ref.get("ri:content-title", "")
            display_text = link_body.get_text() if link_body else page_title
            a_tag = soup.new_tag("a", href=f"#{page_title}")
            a_tag.string = display_text or page_title
            link.replace_with(a_tag)
        elif attachment_ref:
            filename = attachment_ref.get("ri:filename", "")
            display_text = link_body.get_text() if link_body else filename
            # 영상 링크 vs 이미지/파일 링크
            if _is_video_file(filename):
                videos_to_download.append(filename)
                a_tag = soup.new_tag("a", href=f"videos/{filename}")
            else:
                a_tag = soup.new_tag("a", href=f"images/{filename}")
            a_tag.string = display_text or filename
            link.replace_with(a_tag)
        else:
            if link_body:
                link.replace_with(link_body)
            else:
                link.decompose()

    # 4) ac:task-list → 체크박스 리스트
    for task_list in soup.find_all("ac:task-list"):
        ul = soup.new_tag("ul")
        for task in task_list.find_all("ac:task"):
            status = task.find("ac:task-status")
            body = task.find("ac:task-body")
            checked = status and status.string == "complete"
            li = soup.new_tag("li")
            checkbox = "☑" if checked else "☐"
            text = body.get_text() if body else ""
            li.string = f"{checkbox} {text}"
            ul.append(li)
        task_list.replace_with(ul)

    # 5) ac:placeholder 제거
    for ph in soup.find_all("ac:placeholder"):
        ph.decompose()

    # 6) ri:user → 사용자 멘션을 텍스트로
    for user in soup.find_all("ri:user"):
        span = soup.new_tag("span")
        span.string = f"@{user.get('ri:account-id', 'user')}"
        user.replace_with(span)

    return str(soup), images_to_download, videos_to_download


def convert_storage_to_markdown(storage_html: str, page_title: str = "") -> tuple[str, list[str], list[str]]:
    """Confluence storage format → Markdown 변환.

    Args:
        storage_html: Confluence storage format HTML
        page_title: 페이지 제목 (h1으로 삽입)

    Returns:
        (markdown_text, images_to_download 리스트, videos_to_download 리스트)
    """
    if not storage_html or not storage_html.strip():
        header = f"# {page_title}\n\n" if page_title else ""
        return f"{header}(빈 페이지)\n", [], []

    # 1단계: Confluence 특수 요소 → 표준 HTML
    preprocessed_html, images, videos = _preprocess_confluence_html(storage_html)

    # 2단계: HTML → Markdown (markdownify)
    markdown = md(
        preprocessed_html,
        heading_style="ATX",
        bullets="-",
        strong_em_symbol="**",
        strip=["script", "style"],
        escape_asterisks=False,
        escape_underscores=False,
    )

    # 3단계: 후처리
    # 연속 빈 줄 정리 (3줄 이상 → 2줄)
    markdown = re.sub(r"\n{3,}", "\n\n", markdown)
    # 앞뒤 공백 정리
    markdown = markdown.strip() + "\n"

    # 페이지 제목 추가
    if page_title:
        markdown = f"# {page_title}\n\n{markdown}"

    return markdown, images, videos
