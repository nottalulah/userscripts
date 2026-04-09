// ==UserScript==
// @name         Pixiv Image Searches and Stuff
// @description  Searches Danbooru for pixiv IDs and source mismatches, adds IQDB image search links, and filters images based on pixiv favorites.
// @match        *://www.pixiv.net/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @downloadURL  https://github.com/nottalulah/userscripts/raw/master/Pixiv_Image_Searches_and_Stuff.user.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.2.1/jquery.min.js
// @version      2026.04.09
// ==/UserScript==

/* You must be logged into Danbooru (or your preferred site mirror) for all features to work! */

var danbooruURL = "https://danbooru.donmai.us/"; // Change this to your preferred subdomain if desired (sonohara, hijiribe). Make sure to include the final backslash.
var iqdbURL = "https://danbooru.donmai.us/iqdb_queries?url="; // Replace with "https://danbooru.iqdb.org/?url=" (Danbooru) or "https://iqdb.org/?url=" (multi-service) if you prefer those services.
var sauceURL = "https://saucenao.com/search.php?db=999&url=";
var addIQDBSearch = true; //IQDB search button
var addSourceSearch = true; //Danbooru post search (looks for matching pixiv IDs); **Requires GM_xmlhttpRequest**
var ignoreMismatch = false; //ignores mismatch highlighting
var ignoreBadRevision = false; //ignores alternate highlighting of source mismatch tagged "has_bad_revision"

/* CSS Styling + Other Options */
var styleSourceFound = "color:green; font-weight: bold;";
var styleSourceMismatch = "color:purple; font-weight: bold;";
var styleSourceBadRevision = "color:darkorange; font-weight: bold; font-style: italic;";
var styleSourceMissing = "color:red;";
var sourceTimeout = 20; //seconds to wait before retrying query
var maxAttempts = 10; //# of times to try a query before completely giving up on source searches
var imageCheckPeriod = 1000; //Interval (in milliseconds) between each check for images on every page
var thumbCheckPeriod = 1000; //Interval (in milliseconds) between each check on search/bookmark pages
var pixivTransparentSrc = "https://s.pximg.net/www/images/common/transparent.gif";

//////////////////////////////////////////////////////////////////////////////////////

const xsearchselectors = [
    "descendant-or-self::div/a[contains(@href,'mode=medium')]//img[not(@pisas)]", // 0
    "descendant-or-self::div/a[contains(@href,'artworks')]/div/div/img[not(@pisas)]", // 1
    "descendant-or-self::div/a[contains(@class,'gtm-illust-recommend-thumbnail-link') and contains(@href,'artworks')]//img[not(@pisas)]", // 2
    "descendant-or-self::section/div/div/ul/li//div/a[contains(@href,'artworks')]/div/div/img[not(@pisas)]", // 3
    "descendant-or-self::section/div/div/ul/li//div/a[contains(@href,'artworks')]/div/img[not(@pisas)]", // 5
    "descendant-or-self::ol/li/div/a[contains(@href,'artworks')]/img[not(@pisas)]", // 7
    "descendant-or-self::section//figure//a/img[not(@pisas)]", // 8
    "descendant-or-self::div[@data-ga4-label = 'works_content']//a[contains(@href,'artworks')]//img[not(@pisas)]", // 7 (for real)
    "descendant-or-self::section[@data-ga4-label = 'tag_works_content']//ul/li//a[contains(@href,'artworks')]//img[not(@pisas)]", // 8, latest
    "descendant-or-self::div[@data-ga4-label = 'page_root']/div/div/div/section//a[contains(@href,'artworks')]//img[not(@pisas)]", // 9, recommended
];

const pageselectors = [
    { //3
        regex: /^\/(?:\w+\/)?artworks\//,
        selectors: [1, 2, 6]
    }, { //5
        regex: /^\/bookmark_new_illust\.php/,
        selectors: [1]
    }, { //6
        regex: /^\/discovery/,
        selectors: [1]
    }, { //7
        regex: /^\/stacc/,
        selectors: [0]
    }, { //8
        regex: /^\/ranking\.php/,
        selectors: [1, 5]
    }, { //9
        regex: /^\/(?:\w+\/)?tags\//,
        selectors: [1, 7]
    }, {
        regex: /^\/search/,
        selectors: [7],
    }, { //10
        regex: /^\/(?:\w+\/)?users\//,
        selectors: [1]
    }, { //11
        regex: /^\/(?:en\/)?$/,
        selectors: [1, 8, 9]
    }, {
        regex: /^\/(?:\w+\/)?request/,
        selectors: [5]
    },
];

if (window == window.top) //Don't run if inside an iframe
{
    //Prevent added links sometimes being hidden for thumbnails with long titles
    var style = document.createElement('style');
    style.type = 'text/css';
    style.innerHTML = 'li.image-item {overflow:visible !important}\n';
    document.getElementsByTagName('head')[0].appendChild(style);

    setInterval(async () => { await processThumbs(); }, imageCheckPeriod);
}

//====================================== Functions ======================================

// Helpers
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function pageNumber(thumbImg) {
    if (!$(".gtm-medium-work-expanded-view").length) {
        return -1;
    } else if (thumbImg.closest("a")?.classList?.contains("gtm-illust-recommend-thumbnail-link")) {
        return -1;
    } else {
        return pixivPageNumber(thumbImg.src || thumbImg.href);
    }
}

function pixivIllustID(url) {
    var matcher = url.match(/\/(\d+)(?:-[a-f0-9]+)?(_|\.)[^\/]+$/) || url.match(/\/artworks\/(\d+)/);
    return matcher && matcher[1];
}

function pixivPageNumber(url) {
    url = url.replace(/custom/g, "master").replace(/square/g, "master");
    var matcher = url.match(/_p(\d+)(_master\d+)?\./);
    return matcher ? matcher[1] : "x";
}

function GM_fetch(url, params) {
    return new Promise((resolve) => {
        GM_xmlhttpRequest({
            url: url,
            method: "GET",
            ...params,
            onload: resolve,
        });
    });
}

/**
 * tokenize image URLs as per current pixiv URL schema
 * 1: date revised e.g. 2017/09/18/12/03/21 OR pixiv user id
 * 2: pixiv ID e.g. 65020694
 * 3: page number e.g. 3
 */
function tokenizePixivURL(url) {
    var matcher = url.match(/(\d+\/\d+\/\d+\/\d+\/\d+\/\d+)\/(\d+)(?:-[a-f0-9]+)?(?:_big)?_p(\d+)(?:_\w*\d*)?[^\/]+$/);
    // handles ugoira
    if (!matcher) {
        matcher = url.match(/(\d+\/\d+\/\d+\/\d+\/\d+\/\d+)\/(\d+)(?:-[a-f0-9]+)?(?:_big)?(?:_\w*\d*)?[^\/]+$/);
    }
    // handles older pixiv URLs (multiple)
    if (!matcher) {
        matcher = url.match(/([a-z0-9]+)\/(\d+)(?:_big)?_p(\d+)(?:_\w*\d*)?[^\/]+$/);
    }
    // handles older pixiv URLs (single)
    if (!matcher) {
        matcher = url.match(/([a-z0-9]+)\/(\d+)(?:_\w*\d*)?[^\/]+$/);
    }
    if (matcher) {
        matcher[3] = matcher[3] || 0;
    }
    return matcher ? matcher : [url, "", "", ""]; // this should never be false, *hopefully*
}

function createDummyDiv(thumbUrl, styles = {}) {
    styles = Object.assign(styles || {}, {
        justifyContent: "center",
        display: "flex",
        paddingBottom: "1em",
    });
    let src = thumbUrl
        .replace(/c\/.+\/custom-thumb/, "img-master")
        .replace(/square1200/, "master1200")
        .replace(/custom1200/, "master1200");

    let dummyDiv = document.createElement("div");
    dummyDiv.className = "pisas-dummydiv";
    for (const [name, value] of Object.entries(styles)) {
        dummyDiv.style[name] = value;
    }

    let iqdbLink = document.createElement("a");
    iqdbLink.textContent = "(Q)";
    iqdbLink.href = iqdbURL + src;
    let sauceNaoLink = document.createElement("a");
    sauceNaoLink.textContent = "(S)";
    sauceNaoLink.href = sauceURL + src;

    dummyDiv.appendChild(iqdbLink);
    dummyDiv.appendChild(sauceNaoLink);

    return dummyDiv;
}

// Main functions
async function processThumbs() {
    const isNew = /\/((?:en\/)?$)|request/.test(window.location.pathname);

    var thumbSearch = [],
        thumbList = [];

    const matchedSelectors = pageselectors.filter(it => it.regex.test(location.pathname))[0];
    if (!matchedSelectors) {
        console.log("No page match!");
        return;
    }
    const xpathSelector = matchedSelectors.selectors.map(i => xsearchselectors[i]).join(" | ");
    const results = document.evaluate(xpathSelector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (let i = 0; i < results.snapshotLength; i++) {
        const item = results.snapshotItem(i);
        thumbSearch.push(item);
        item.setAttribute("pisas", "done");
    }
    if (thumbSearch.length === 0) {
        return;
    } else {
        console.log("Images found:", thumbSearch);
    }
    for (const thumbImg of thumbSearch) {
        let thumbCont = thumbImg;
        while (thumbCont.tagName != "A") {
            thumbCont = thumbCont.parentElement;
        }
        thumbCont = thumbCont.parentNode;
        thumbCont.style.marginBottom = isNew ? "" : "1em";

        if ($(".pisas-dummydiv", thumbCont).length > 0) {
            console.log("Already processed!");
            continue;
        }

        const paddingBottom = isNew ? "" : "1em";
        let dummyDiv = createDummyDiv(thumbImg.src, { paddingBottom });

        if (isNew) {
            thumbCont.insertAdjacentElement("afterend", dummyDiv);
        } else {
            thumbCont.appendChild(dummyDiv);
        }

        if (addSourceSearch && (!thumbImg.src || thumbImg.src.indexOf("/novel/") < 0) && pixivIllustID(thumbImg.src || thumbImg.href)) {
            dummyDiv.appendChild(document.createTextNode(" "));
            let page = pageNumber(thumbImg);
            thumbList.push({
                link: dummyDiv.appendChild(document.createElement("a")),
                pixiv_id: pixivIllustID(thumbImg.src || thumbImg.href),
                src: thumbImg.src,
                page: page,
            });
        }
    }
    await sourceSearch(thumbList);
}

async function sourceSearch(thumbList, attempt, page) {
    //thumbList[index] = { link, id, page? }

    if (page === undefined) {
        //First call.  Finish initialization
        attempt = page = 1;

        for (let i = 0; i < thumbList.length; i++) {
            if (!thumbList[i].status) {
                thumbList[i].status = thumbList[i].link.parentNode.appendChild(document.createElement("span"));
            }
            thumbList[i].link.textContent = "Searching...";
            thumbList[i].posts = [];
        }
    }

    if (attempt >= maxAttempts) {
        //Too many failures (or Downbooru); give up. :(
        for (let i = 0; i < thumbList.length; i++) {
            thumbList[i].status.style.display = "none";
            if (thumbList[i].link.textContent[0] != '(') {
                thumbList[i].link.textContent = "(error)";
            }
            thumbList[i].link.setAttribute("style", "color:blue; font-weight: bold;");
        }
        return;
    }

    //Is there actually anything to process?
    if (thumbList.length === 0) {
        return;
    }

    //Retry this call if timeout
    var retry = (function (a, b, c) {
        return function () {
            setTimeout(function () {
                sourceSearch(a, b, c);
            }, maxAttempts === 0 ? 0 : 1000);
        };
    })(thumbList, attempt + 1, page);
    var sourceTimer = setTimeout(retry, sourceTimeout * 1000);

    var idList = [];
    for (let i = 0; i < thumbList.length; i++) {
        thumbList[i].status.textContent = " [" + attempt + "]";
        if (idList.indexOf(thumbList[i].pixiv_id) < 0) {
            idList.push(thumbList[i].pixiv_id);
        }
    }

    const url = danbooruURL + 'posts.json?limit=100&tags=status:any+pixiv:' + idList.join() + '&page=' + page;
    const responseDetails = await GM_fetch(url, { onerror: retry, onabort: retry });
    clearTimeout(sourceTimer);

    //Check server response for errors
    var result = false,
        status = null;

    if (/^ *$/.test(responseDetails.responseText)) {
        status = "(error)"; //No content
    } else if (responseDetails.status == 503) {
        addSourceSearch = maxAttempts = 0; //Give up
        status = "(Downbooru)";
    } else {
        try {
            result = JSON.parse(responseDetails.responseText);
            if (result.success !== false) {
                status = "Searching...";
            } else {
                status = "(" + (result.message || "error") + ")";
                addSourceSearch = maxAttempts = 0; //Give up
                result = false;
            }
        } catch (err) {
            result = false;
            status = "(parse error)";
        }
    }
    //Update thumbnail messages
    for (let i = 0; i < thumbList.length; i++) {
        thumbList[i].link.textContent = status;
    }

    if (result === false) {
        return retry(); //Hit an error; try again?
    }

    //predefining some functions for good measure
    var setStyleSingle = function (thumb) {
        if (!ignoreMismatch && tokenizePixivURL(thumb.src)[1] !== tokenizePixivURL(thumb.posts[0].src)[1]) {
            if (!ignoreBadRevision && thumb.posts[0].isBadRevision) {
                thumb.link.setAttribute("style", styleSourceBadRevision);
            } else {
                thumb.link.setAttribute("style", styleSourceMismatch);
            }
        } else {
            thumb.link.setAttribute("style", styleSourceFound);
        }
    };

    var setStyleMulti = function (thumb) {
        if (ignoreMismatch) {
            thumb.link.setAttribute("style", styleSourceFound);
            return;
        }
        let postsMap = thumb.posts.map(function (x) {
            return [tokenizePixivURL(x.src), x.isBadRevision];
        });
        let revDate = tokenizePixivURL(thumb.src)[1];
        let store = {};
        let matchArray = [];
        postsMap.forEach(function (post) {
            store[post[0][3]] = store[post[0][3]] || [];
            // page number -> [date revised, isBadRevision]
            store[post[0][3]].push([post[0][1], post[1]]);
        });
        for (let pageIndex in store) {
            let isMatch = false;
            let seenBadRevision = false;
            for (let j = 0; j < store[pageIndex].length; j++) {
                if (store[pageIndex][j][0] === revDate) {
                    // current image is uploaded
                    isMatch = true;
                    break;
                } else if (store[pageIndex][j][1] && !ignoreBadRevision) {
                    seenBadRevision = true;
                }
            }
            if (isMatch) matchArray.push(true);
            else if (!seenBadRevision) matchArray.push(false);
            else matchArray.push("bad revision");
        }
        if (matchArray.includes(false)) thumb.link.setAttribute("style", styleSourceMismatch);
        else if (matchArray.includes("bad revision")) thumb.link.setAttribute("style", styleSourceBadRevision);
        else thumb.link.setAttribute("style", styleSourceFound);
    };

    for (let i = 0; i < thumbList.length; i++) {
        //Collect the IDs of every post with the same pixiv_id/page as the pixiv image
        for (let j = 0; j < result.length; j++) {
            if (thumbList[i].pixiv_id == result[j].pixiv_id && thumbList[i].posts.indexOf(result[j].id) < 0 && (thumbList[i].page < 0 || thumbList[i].page == pixivPageNumber(result[j].source))) {
                thumbList[i].link.title = result[j].tag_string + " rating:" + result[j].rating + " score:" + result[j].score;
                thumbList[i].posts.push({
                    "id": result[j].id,
                    "src": result[j].source,
                    "isBadRevision": result[j].tag_string.split(" ").includes("has_bad_revision"),
                });
            }
        }

        if (thumbList[i].posts.length === 1) {
            //Found one post; link directly to it
            thumbList[i].link.textContent = "post #" + thumbList[i].posts[0].id;
            thumbList[i].link.href = danbooruURL + "posts/" + thumbList[i].posts[0].id;
            setStyleSingle(thumbList[i]);
        } else if (thumbList[i].posts.length > 1) {
            //Found multiple posts; link to tag search
            thumbList[i].link.textContent = "(" + thumbList[i].posts.length + " sources)";
            thumbList[i].link.href = danbooruURL + "posts?tags=status:any+pixiv:" + thumbList[i].pixiv_id;
            setStyleMulti(thumbList[i]);
            thumbList[i].link.removeAttribute("title");
        }
    }

    if (result.length === 100) {
        sourceSearch(thumbList, attempt + 1, page + 1); //Max results returned, so fetch the next page
    } else {
        for (let i = 0; i < thumbList.length; i++) {
            //No more results will be forthcoming; hide the status counter and set the links for the images without any posts
            thumbList[i].status.style.display = "none";
            if (thumbList[i].posts.length === 0) {
                thumbList[i].link.textContent = "(no sources)";
                thumbList[i].link.setAttribute("style", styleSourceMissing);
            }
        }
    }
}
