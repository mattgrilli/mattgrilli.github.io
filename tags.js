function showTagResults(snippets, tag, snippetList) {
    const tagResultsHeader = document.createElement('h3');
    tagResultsHeader.textContent = `Showing results with the tag "${tag}".`;
    tagResultsHeader.id = 'tag-results-header';
    snippetList.insertBefore(tagResultsHeader, snippetList.firstChild);
    const clearTagsButton = document.createElement('button');
    clearTagsButton.textContent = 'Clear Tags';
    clearTagsButton.addEventListener('click', function() {
      window.location.hash = '';
      displaySnippets(snippets, snippetList);
    });
    tagResultsHeader.appendChild(clearTagsButton);
    
    displaySnippets(snippets, snippetList); // <-- Add this line
  }

  function createTagContainer(snippet, snippetList) {
    const tagContainer = document.createElement('div');
    tagContainer.classList.add('tag-container');
    const tagLabel = document.createElement('span');
    tagLabel.textContent = 'Tags: ';
    tagLabel.classList.add('tag-label');
    tagContainer.appendChild(tagLabel);
    const tags = snippet.tags.split(',').map(function(tag) {
      return tag.trim();
    });
    tags.forEach(function(tag) {
      const tagLink = document.createElement('a');
      tagLink.textContent = tag.toLowerCase();
      tagLink.href = `#${tag.toLowerCase()}`;
      tagLink.addEventListener('click', function(event) {
        event.preventDefault();
        const clickedTag = event.target.textContent;
        const filteredSnippets = filterByTag(savedSnippets, clickedTag);
        displaySnippets(filteredSnippets, snippetList);
        let tagResultsHeader = document.getElementById('tag-results-header');
        if (!tagResultsHeader) {
          tagResultsHeader = document.createElement('h3');
          tagResultsHeader.id = 'tag-results-header';
          snippetList.insertBefore(tagResultsHeader, snippetList.firstChild);
        }
        tagResultsHeader.textContent = `Showing results with the tag "${clickedTag}".`;
        const clearTagsButton = document.createElement('button');
        clearTagsButton.textContent = 'Clear Tags';
        clearTagsButton.classList.add('clear-tags-button');
        clearTagsButton.style.marginLeft = '100px';
  
        
        clearTagsButton.addEventListener('click', function() {
          window.location.hash = '';
          displaySnippets(savedSnippets, snippetList);
        });
        tagResultsHeader.appendChild(clearTagsButton);
      });
      tagContainer.appendChild(tagLink);
    });
    return tagContainer;
  }
  
  
  
  
  
  
  function createTagLink(tag) {
    const tagLink = document.createElement('a');
    tagLink.textContent = tag.toLowerCase();
    tagLink.href = `#${tag.toLowerCase()}`;
    return tagLink;
  }
  
  function filterSnippetsByTag(snippets, tag) {
    if (!tag) {
      return snippets;
    }
    return snippets.filter(function(snippet) {
      return snippet.tags.split(',').map(function(t) {
        return t.trim().toLowerCase();
      }).includes(tag.toLowerCase());
    });
  }
  
  function createTagResultsHeader(tag, clearTagsButtonCallback) {
    const tagResultsHeader = document.createElement('h3');
    tagResultsHeader.textContent = `Showing results with the tag "${tag}".`;
    const clearTagsButton = document.createElement('button');
    clearTagsButton.textContent = 'Clear Tags';
    clearTagsButton.addEventListener('click', clearTagsButtonCallback);
    tagResultsHeader.appendChild(clearTagsButton);
    return tagResultsHeader;
  }
  
  function clearTagResults() {
    const tagResultsHeader = document.getElementById('tag-results-header');
    if (tagResultsHeader) {
      tagResultsHeader.remove();
    }
  }

  function updateTagFilterDescription(tag) {
    const tagFilterDescription = document.getElementById('tag-filter-description');
    tagFilterDescription.textContent = `Showing results with the tag ${tag}`;
  }